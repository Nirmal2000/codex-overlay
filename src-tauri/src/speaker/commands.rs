use crate::echo::EchoCancellationState;
use crate::microphone::samples_to_pcm16;
use crate::speaker::{AudioDevice, SpeakerInput};
use crate::transcribe::{self, AudioSource};
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tracing::{error, warn};

#[tauri::command]
pub async fn start_system_audio_capture(
    app: AppHandle,
    device_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();
    if state
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to acquire lock: {e}"))?
        .is_some()
    {
        warn!("Capture already running");
        return Err("Capture already running".into());
    }

    // On macOS, connect STT before creating/starting the CoreAudio IOProc.
    // Previously the tap filled its bounded ring buffer during the STT
    // handshake, so an active meeting could terminate capture before its
    // consumer even began.
    #[cfg(target_os = "macos")]
    let sample_rate = crate::speaker::output_sample_rate(device_id.as_deref())
        .map_err(|error| format!("Failed to read output sample rate: {error}"))?;
    #[cfg(not(target_os = "macos"))]
    let input = SpeakerInput::new_with_device(device_id.clone()).map_err(|e| {
        error!("Failed to create speaker input: {e}");
        format!("Failed to access system audio: {e}")
    })?;
    #[cfg(not(target_os = "macos"))]
    let stream = input.stream();
    #[cfg(not(target_os = "macos"))]
    let sample_rate = stream.sample_rate();
    let grok = app.state::<transcribe::TranscriptionState>();
    let sender =
        transcribe::start_stream(app.clone(), grok.inner(), AudioSource::Speaker, sample_rate)
            .await?;
    #[cfg(target_os = "macos")]
    let stream = {
        match SpeakerInput::new_with_device(device_id) {
            Ok(input) => input.stream(),
            Err(error) => {
                error!("Failed to create speaker input: {error}");
                let cleanup_app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = cleanup_app.state::<transcribe::TranscriptionState>();
                    transcribe::stop_stream(state.inner(), AudioSource::Speaker).await;
                });
                return Err(format!("Failed to access system audio: {error}"));
            }
        }
    };
    let echo = app.state::<EchoCancellationState>().inner().clone();

    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to set capturing state: {e}"))? = true;
    let task_app = app.clone();
    let task = tokio::spawn(async move {
        let result = stream_pcm(stream, sample_rate, sender, echo, task_app.clone()).await;
        let state = task_app.state::<crate::AudioState>();
        if let Ok(mut guard) = state.stream_task.lock() {
            *guard = None;
        };
        if let Ok(mut capturing) = state.is_capturing.lock() {
            *capturing = false;
        }
        if let Err(error) = result {
            let _ = task_app.emit("speaker-capture-error", error);
        }
    });
    *state
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to store task: {e}"))? = Some(task);
    let _ = app.emit("capture-started", sample_rate);
    Ok(())
}

async fn stream_pcm(
    mut stream: impl StreamExt<Item = f32> + Unpin,
    sample_rate: u32,
    sender: tokio::sync::mpsc::Sender<Vec<u8>>,
    echo: EchoCancellationState,
    app: AppHandle,
) -> Result<(), String> {
    let aec_frame_samples = sample_rate as usize / 100;
    let stt_frame_samples = sample_rate as usize / 10;
    let mut aec_samples = Vec::with_capacity(aec_frame_samples * 2);
    let mut stt_samples = Vec::with_capacity(stt_frame_samples * 2);
    let mut aec_active_reported = false;
    let mut aec_error_reported = false;
    let mut level_frames = 0_u8;
    while let Some(sample) = stream.next().await {
        aec_samples.push(sample);
        stt_samples.push(sample);
        while aec_samples.len() >= aec_frame_samples {
            let frame = aec_samples.drain(..aec_frame_samples).collect::<Vec<_>>();
            match echo.process_render_frame(&frame, sample_rate) {
                Ok(resampled) if !aec_active_reported => {
                    let detail = if resampled {
                        "AEC3 active · system audio resampled to microphone rate"
                    } else {
                        "AEC3 active · system audio reference aligned to microphone"
                    };
                    let _ = app.emit("echo-cancellation-status", detail);
                    aec_active_reported = true;
                    aec_error_reported = false;
                }
                Ok(_) => {}
                Err(error) if !aec_error_reported => {
                    aec_active_reported = false;
                    let _ = app.emit(
                        "echo-cancellation-status",
                        format!("AEC waiting · {error} · transcript fallback active"),
                    );
                    aec_error_reported = true;
                }
                Err(_) => {
                    aec_active_reported = false;
                }
            }
        }
        if stt_samples.len() >= stt_frame_samples {
            let frame = stt_samples.drain(..stt_frame_samples).collect::<Vec<_>>();
            let rms = if frame.is_empty() {
                0.0
            } else {
                (frame
                    .iter()
                    .map(|sample| (*sample as f64).powi(2))
                    .sum::<f64>()
                    / frame.len() as f64)
                    .sqrt() as f32
            };
            level_frames = level_frames.wrapping_add(1);
            if level_frames % 2 == 0 {
                let _ = app.emit("speaker-level", rms);
            }
            if sender.send(samples_to_pcm16(&frame)).await.is_err() {
                return Err("Speaker transcription stream disconnected".into());
            }
        }
    }
    Err("Speaker capture stream stopped delivering audio".into())
}

#[tauri::command]
pub async fn stop_system_audio_capture(app: AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();
    if let Some(task) = state
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to acquire task lock: {e}"))?
        .take()
    {
        task.abort();
    }
    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to update capturing state: {e}"))? = false;
    let grok = app.state::<transcribe::TranscriptionState>();
    transcribe::stop_stream(grok.inner(), AudioSource::Speaker).await;
    let _ = app.emit(
        "echo-cancellation-status",
        "AEC3 ready · waiting for system audio",
    );
    let _ = app.emit("capture-stopped", ());
    Ok(())
}

#[tauri::command]
pub fn check_system_audio_access(_app: AppHandle) -> Result<bool, String> {
    match SpeakerInput::new() {
        Ok(_) => Ok(true),
        Err(e) => {
            error!("System audio access check failed: {e}");
            Ok(false)
        }
    }
}

#[tauri::command]
pub async fn request_system_audio_access(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.shell()
        .command("open")
        .args(["x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"])
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    app.shell()
        .command("ms-settings:sound")
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    app.shell()
        .command("pavucontrol")
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn get_capture_status(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<crate::AudioState>();
    let capturing = *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to get capture status: {e}"))?;
    Ok(capturing)
}

#[tauri::command]
pub fn get_audio_sample_rate(_app: AppHandle) -> Result<u32, String> {
    let input = SpeakerInput::new().map_err(|e| e.to_string())?;
    Ok(input.stream().sample_rate())
}

#[tauri::command]
pub fn get_input_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_input_devices().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_output_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_output_devices().map_err(|e| e.to_string())
}
