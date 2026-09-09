use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::credentials::load_secret;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum AudioSource {
    Microphone,
    Speaker,
}

impl AudioSource {
    fn label(self) -> &'static str {
        match self {
            Self::Microphone => "You",
            Self::Speaker => "Speaker",
        }
    }

    fn vad_threshold(self) -> &'static str {
        match self {
            Self::Microphone => "0.15",
            Self::Speaker => "0.08",
        }
    }
}

#[derive(Clone, Serialize)]
struct TranscriptEvent {
    source: &'static str,
    text: String,
    words: Value,
    is_final: bool,
    speech_final: bool,
    start: f64,
    duration: f64,
}

struct StreamHandle {
    sender: mpsc::Sender<Vec<u8>>,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct TranscriptionState {
    streams: Mutex<HashMap<AudioSource, StreamHandle>>,
}

pub async fn start_stream(
    app: AppHandle,
    state: &TranscriptionState,
    source: AudioSource,
    sample_rate: u32,
) -> Result<mpsc::Sender<Vec<u8>>, String> {
    if ![8_000, 16_000, 22_050, 24_000, 44_100, 48_000].contains(&sample_rate) {
        return Err(format!("xAI STT does not support {sample_rate} Hz audio"));
    }
    stop_stream(state, source).await;

    let key = load_secret(Some(&app), "XAI_API_KEY")?;
    let url = format!(
        "wss://api.x.ai/v1/stt?encoding=pcm&sample_rate={sample_rate}&interim_results=true&language=en&channels=1&endpointing=500&vad_threshold={}",
        source.vad_threshold()
    );
    let mut request = url
        .into_client_request()
        .map_err(|error| error.to_string())?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| "XAI_API_KEY contains invalid header characters")?,
    );
    let (socket, _) = tokio::time::timeout(Duration::from_secs(6), connect_async(request))
        .await
        .map_err(|_| "xAI STT connection timed out".to_string())?
        .map_err(|error| format!("Failed to connect to xAI STT: {error}"))?;
    let (mut writer, mut reader) = socket.split();
    let (sender, mut audio) = mpsc::channel::<Vec<u8>>(100);
    let (ready_sender, ready_receiver) = oneshot::channel::<Result<(), String>>();
    let mut ready_sender = Some(ready_sender);
    let event_app = app.clone();
    let task = tokio::spawn(async move {
        let mut keepalive = tokio::time::interval(Duration::from_millis(100));
        keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_audio = Instant::now();
        let silence = vec![0_u8; sample_rate as usize / 10 * 2];
        loop {
            tokio::select! {
                frame = audio.recv() => {
                    let Some(frame) = frame else {
                        let _ = writer.send(Message::Text(r#"{"type":"audio.done"}"#.into())).await;
                        break;
                    };
                    if writer.send(Message::Binary(frame.into())).await.is_err() {
                        let _ = event_app.emit("grok-transcription-error", format!("{} STT stream disconnected", source.label()));
                        break;
                    }
                    last_audio = Instant::now();
                }
                _ = keepalive.tick(), if source == AudioSource::Speaker => {
                    // A CoreAudio process tap waits when no application is
                    // producing output. Keep the STT socket alive during that
                    // silence so it is still present when a meeting begins.
                    if last_audio.elapsed() >= Duration::from_millis(150)
                        && writer.send(Message::Binary(silence.clone().into())).await.is_err()
                    {
                        let _ = event_app.emit("grok-transcription-error", "Speaker STT stream disconnected");
                        break;
                    }
                }
                message = reader.next() => {
                    let Some(message) = message else {
                        let _ = event_app.emit("grok-transcription-error", format!("{} STT stream closed", source.label()));
                        break;
                    };
                    let message = match message {
                        Ok(message) => message,
                        Err(error) => {
                            if let Some(ready) = ready_sender.take() {
                                let _ = ready.send(Err(error.to_string()));
                            }
                            let _ = event_app.emit("grok-transcription-error", format!("{} STT: {error}", source.label()));
                            break;
                        }
                    };
                    let Message::Text(text) = message else { continue };
                    let Ok(event) = serde_json::from_str::<Value>(&text) else { continue };
                    match event.get("type").and_then(Value::as_str) {
                        Some("transcript.created") => {
                            if let Some(ready) = ready_sender.take() {
                                let _ = ready.send(Ok(()));
                            }
                            let _ = event_app.emit("grok-transcription-ready", source.label());
                        }
                        Some("transcript.partial") => {
                            let text = event.get("text").and_then(Value::as_str).unwrap_or_default().trim();
                            if text.is_empty() { continue }
                            let is_final = event.get("is_final").and_then(Value::as_bool).unwrap_or(false);
                            let speech_final = event.get("speech_final").and_then(Value::as_bool).unwrap_or(false);
                            let _ = event_app.emit("grok-transcript-update", TranscriptEvent {
                                source: source.label(),
                                text: text.to_string(),
                                words: event.get("words").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
                                is_final,
                                speech_final,
                                start: event.get("start").and_then(Value::as_f64).unwrap_or_default(),
                                duration: event.get("duration").and_then(Value::as_f64).unwrap_or_default(),
                            });
                        }
                        Some("error") => {
                            let message = event.get("message").and_then(Value::as_str).unwrap_or("xAI STT error").to_string();
                            if let Some(ready) = ready_sender.take() {
                                let _ = ready.send(Err(message.clone()));
                            }
                            let _ = event_app.emit("grok-transcription-error", format!("{} STT: {message}", source.label()));
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
    });

    match tokio::time::timeout(Duration::from_secs(6), ready_receiver).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => {
            task.abort();
            return Err(error);
        }
        Ok(Err(_)) => {
            task.abort();
            return Err("xAI STT closed before becoming ready".into());
        }
        Err(_) => {
            task.abort();
            return Err("xAI STT readiness timed out".into());
        }
    }

    state.streams.lock().await.insert(
        source,
        StreamHandle {
            sender: sender.clone(),
            task,
        },
    );
    Ok(sender)
}

pub async fn stop_stream(state: &TranscriptionState, source: AudioSource) {
    if let Some(stream) = state.streams.lock().await.remove(&source) {
        drop(stream.sender);
        stream.task.abort();
    }
}
