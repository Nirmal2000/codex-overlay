use crate::echo::EchoCancellationState;
use crate::transcribe::{self, AudioSource};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

pub struct MicrophoneState {
    generation: Arc<AtomicU64>,
}

impl Default for MicrophoneState {
    fn default() -> Self {
        Self {
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[derive(Serialize)]
pub struct MicrophoneDevice {
    name: String,
    is_default: bool,
}

#[tauri::command]
pub fn get_microphone_devices() -> Result<Vec<MicrophoneDevice>, String> {
    let host = cpal::default_host();
    let default = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    host.input_devices()
        .map_err(|e| format!("Failed to list microphones: {e}"))?
        .map(|device| {
            let name = device
                .name()
                .map_err(|e| format!("Failed to read microphone name: {e}"))?;
            Ok(MicrophoneDevice {
                is_default: default.as_deref() == Some(&name),
                name,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn start_microphone_capture(
    app: AppHandle,
    state: tauri::State<'_, MicrophoneState>,
    device_name: Option<String>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = select_device(&host, device_name.as_deref())?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("Failed to read microphone format: {e}"))?;
    let sample_rate = supported.sample_rate().0;
    let echo = app.state::<EchoCancellationState>().inner().clone();
    echo.configure_capture(sample_rate)?;
    let _ = app.emit(
        "echo-cancellation-status",
        format!("AEC3 ready at {sample_rate} Hz · waiting for system audio"),
    );
    let state_app = app.clone();
    let grok = state_app.state::<transcribe::TranscriptionState>();
    let sender = transcribe::start_stream(
        app.clone(),
        grok.inner(),
        AudioSource::Microphone,
        sample_rate,
    )
    .await?;

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let current_generation = state.generation.clone();
    let selected_name = device
        .name()
        .unwrap_or_else(|_| "Selected microphone".into());
    let (ready_sender, ready_receiver) = std_mpsc::sync_channel::<Result<(), String>>(1);
    let thread_generation = current_generation.clone();
    std::thread::spawn(move || {
        let result = run_microphone(
            app.clone(),
            current_generation,
            generation,
            device,
            supported,
            sender,
            echo,
            selected_name,
            ready_sender.clone(),
        );
        if let Err(error) = result {
            let _ = ready_sender.send(Err(error.clone()));
            let _ = app.emit("microphone-error", error);
        }
    });

    let ready = tokio::task::spawn_blocking(move || {
        ready_receiver.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|error| format!("Microphone startup task failed: {error}"))?;
    match ready {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => {
            thread_generation.fetch_add(1, Ordering::SeqCst);
            transcribe::stop_stream(grok.inner(), AudioSource::Microphone).await;
            Err(error)
        }
        Err(_) => {
            thread_generation.fetch_add(1, Ordering::SeqCst);
            transcribe::stop_stream(grok.inner(), AudioSource::Microphone).await;
            Err("Microphone opened but no audio samples arrived within 5 seconds".into())
        }
    }
}

fn select_device(host: &cpal::Host, device_name: Option<&str>) -> Result<cpal::Device, String> {
    match device_name {
        Some(name) => host
            .input_devices()
            .map_err(|e| format!("Failed to list microphones: {e}"))?
            .find(|device| {
                device
                    .name()
                    .map(|candidate| candidate == name)
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("Microphone not found: {name}")),
        None => host
            .default_input_device()
            .ok_or("No microphone found".into()),
    }
}

fn run_microphone(
    app: AppHandle,
    current_generation: Arc<AtomicU64>,
    generation: u64,
    device: cpal::Device,
    supported: cpal::SupportedStreamConfig,
    sender: mpsc::Sender<Vec<u8>>,
    echo: EchoCancellationState,
    selected_name: String,
    ready_sender: std_mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let channels = config.channels as usize;
    let sample_rate = config.sample_rate.0;
    let sample_activity = Arc::new(AtomicU64::new(0));
    let (flow_sender, flow_receiver) = std_mpsc::sync_channel(1);
    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32, _>(
            &device,
            &config,
            channels,
            sample_rate,
            sender,
            echo.clone(),
            app.clone(),
            sample_activity.clone(),
            flow_sender,
            |v| v,
        ),
        SampleFormat::I16 => build_stream::<i16, _>(
            &device,
            &config,
            channels,
            sample_rate,
            sender,
            echo.clone(),
            app.clone(),
            sample_activity.clone(),
            flow_sender,
            |v| v as f32 / i16::MAX as f32,
        ),
        SampleFormat::U16 => build_stream::<u16, _>(
            &device,
            &config,
            channels,
            sample_rate,
            sender,
            echo,
            app.clone(),
            sample_activity.clone(),
            flow_sender,
            |v| v as f32 / u16::MAX as f32 * 2.0 - 1.0,
        ),
        format => return Err(format!("Unsupported microphone format: {format:?}")),
    }?;
    stream
        .play()
        .map_err(|e| format!("Failed to start microphone: {e}"))?;
    flow_receiver
        .recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| "Microphone opened but CoreAudio delivered no samples".to_string())?;
    let _ = app.emit("microphone-ready", selected_name);
    let _ = ready_sender.send(Ok(()));
    let mut last_activity = sample_activity.load(Ordering::Relaxed);
    let mut stagnant_ticks = 0;
    while current_generation.load(Ordering::Relaxed) == generation {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let activity = sample_activity.load(Ordering::Relaxed);
        if activity == last_activity {
            stagnant_ticks += 1;
            if stagnant_ticks >= 12 {
                return Err("Microphone stopped delivering audio samples".into());
            }
        } else {
            last_activity = activity;
            stagnant_ticks = 0;
        }
    }
    drop(stream);
    Ok(())
}

fn build_stream<T, F>(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: usize,
    sample_rate: u32,
    sender: mpsc::Sender<Vec<u8>>,
    echo: EchoCancellationState,
    app: AppHandle,
    sample_activity: Arc<AtomicU64>,
    flow_sender: std_mpsc::SyncSender<()>,
    convert: F,
) -> Result<Stream, String>
where
    T: cpal::SizedSample,
    F: Fn(T) -> f32 + Send + 'static,
{
    let aec_frame_samples = sample_rate as usize / 100;
    let stt_frame_samples = sample_rate as usize / 10;
    let level_window = sample_rate as usize / 5;
    let mut aec_samples = Vec::<f32>::with_capacity(aec_frame_samples * 2);
    let mut stt_samples = Vec::<f32>::with_capacity(stt_frame_samples * 2);
    let mut aec_error_reported = false;
    let mut level_sample_count = 0;
    let mut level_peak = 0.0_f32;
    let mut flow_sender = Some(flow_sender);
    let error_app = app.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if !data.is_empty() {
                    sample_activity.fetch_add(1, Ordering::Relaxed);
                    if let Some(sender) = flow_sender.take() {
                        let _ = sender.try_send(());
                    }
                }
                for frame in data.chunks(channels) {
                    let mono = frame.iter().copied().map(&convert).sum::<f32>() / channels as f32;
                    aec_samples.push(mono);
                    level_sample_count += 1;
                    level_peak = level_peak.max(mono.abs());
                    if level_sample_count >= level_window {
                        let _ = app.emit("microphone-level", level_peak);
                        level_sample_count = 0;
                        level_peak = 0.0;
                    }
                }
                while aec_samples.len() >= aec_frame_samples {
                    let mut frame = aec_samples.drain(..aec_frame_samples).collect::<Vec<_>>();
                    let original = frame.clone();
                    if let Err(error) = echo.process_capture_frame(&mut frame, sample_rate) {
                        frame = original;
                        if !aec_error_reported {
                            let _ = app.emit(
                                "echo-cancellation-status",
                                format!("AEC bypassed · {error} · transcript fallback active"),
                            );
                            aec_error_reported = true;
                        }
                    }
                    stt_samples.extend(frame);
                }
                while stt_samples.len() >= stt_frame_samples {
                    let frame = stt_samples.drain(..stt_frame_samples).collect::<Vec<_>>();
                    let _ = sender.try_send(samples_to_pcm16(&frame));
                }
            },
            move |error| {
                let _ = error_app.emit("microphone-error", error.to_string());
            },
            None,
        )
        .map_err(|e| format!("Failed to open microphone: {e}"))
}

pub(crate) fn samples_to_pcm16(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let value = ((*sample).clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

#[tauri::command]
pub async fn stop_microphone_capture(
    app: AppHandle,
    state: tauri::State<'_, MicrophoneState>,
) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::SeqCst);
    let grok = app.state::<transcribe::TranscriptionState>();
    transcribe::stop_stream(grok.inner(), AudioSource::Microphone).await;
    app.state::<EchoCancellationState>().reset();
    let _ = app.emit("echo-cancellation-status", "AEC stopped");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::samples_to_pcm16;

    #[test]
    fn encodes_signed_little_endian_pcm() {
        assert_eq!(
            samples_to_pcm16(&[-1.0, 0.0, 1.0]),
            vec![1, 128, 0, 0, 255, 127]
        );
    }
}
