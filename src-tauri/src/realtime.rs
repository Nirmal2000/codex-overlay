use base64::Engine;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

use crate::context::{build_prompt_context, ContextInfo, ContextKind};
use crate::credentials::load_secret;
use crate::prompts::realtime_instructions;

pub const REALTIME_MODEL: &str = "gpt-realtime-2.1";
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Writer = Arc<Mutex<SplitSink<Socket, Message>>>;

pub struct RealtimeState {
    writer: Mutex<Option<Writer>>,
    reader_task: Mutex<Option<JoinHandle<()>>>,
    connect_gate: Mutex<()>,
    preparation_gate: Mutex<()>,
    history_gate: Arc<Mutex<()>>,
    ready: Arc<AtomicBool>,
    history_items: Arc<Mutex<Vec<Value>>>,
    turn_references: Mutex<HashMap<String, Vec<Value>>>,
    pending_image_history: Arc<Mutex<HashMap<String, ImageHistoryReplacement>>>,
    context_hash: Mutex<Option<String>>,
    session_generation: AtomicU64,
}

impl Default for RealtimeState {
    fn default() -> Self {
        Self {
            writer: Mutex::new(None),
            reader_task: Mutex::new(None),
            connect_gate: Mutex::new(()),
            preparation_gate: Mutex::new(()),
            history_gate: Arc::new(Mutex::new(())),
            ready: Arc::new(AtomicBool::new(false)),
            history_items: Arc::new(Mutex::new(Vec::new())),
            turn_references: Mutex::new(HashMap::new()),
            pending_image_history: Arc::new(Mutex::new(HashMap::new())),
            context_hash: Mutex::new(None),
            session_generation: AtomicU64::new(0),
        }
    }
}

#[derive(Clone)]
struct ImageHistoryReplacement {
    image_item_id: String,
    replacement: Value,
}

#[derive(Clone, Serialize)]
struct RealtimeDelta {
    turn_id: String,
    delta: String,
}

#[derive(Clone, Serialize)]
struct RealtimeDone {
    turn_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
struct RealtimeFailure {
    turn_id: Option<String>,
    message: String,
}

#[tauri::command]
pub async fn start_realtime_session(
    app: AppHandle,
    state: tauri::State<'_, RealtimeState>,
    direct_context: String,
) -> Result<ContextInfo, String> {
    let generation = state.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let _preparation = state.preparation_gate.lock().await;
    let pack = build_prompt_context(&direct_context, ContextKind::Realtime);
    ensure_current_session(&state, generation)?;
    let current_hash = state.context_hash.lock().await.clone();
    if current_hash.as_deref() != Some(&pack.info.hash) {
        append_history_item_with_reconnect(
            &app,
            &state,
            message_item(
                "system",
                "input_text",
                &format!(
                    "DIRECT_CANDIDATE_CONTEXT version={} hash={}\n<candidate_context>\n{}\n</candidate_context>",
                    pack.info.version, pack.info.hash, pack.text
                ),
            ),
        )
        .await?;
        if let Err(error) = ensure_current_session(&state, generation) {
            reset_connection(&state).await;
            state.history_items.lock().await.clear();
            state.turn_references.lock().await.clear();
            state.pending_image_history.lock().await.clear();
            *state.context_hash.lock().await = None;
            return Err(error);
        }
        *state.context_hash.lock().await = Some(pack.info.hash.clone());
    }
    let _ = app.emit("realtime-context-ready", pack.info.clone());
    Ok(pack.info)
}

#[tauri::command]
pub async fn send_realtime_turn(
    app: AppHandle,
    state: tauri::State<'_, RealtimeState>,
    turn_id: String,
    prompt: String,
    image_paths: Vec<String>,
) -> Result<(), String> {
    if prompt.trim().is_empty() && image_paths.is_empty() {
        return Err("Nothing to send to Realtime".into());
    }
    {
        let preparation = state.preparation_gate.lock().await;
        drop(preparation);
    }
    let mut content = Vec::new();
    if !prompt.trim().is_empty() {
        content.push(json!({ "type": "input_text", "text": prompt.trim() }));
    }
    let image_count = image_paths.iter().filter(|value| !value.is_empty()).count();
    for path in image_paths.into_iter().filter(|value| !value.is_empty()) {
        let image = image_path_to_data_url(&path).await?;
        content.push(json!({ "type": "input_image", "image_url": image, "detail": "auto" }));
    }
    let user_item_id = item_id("user");
    let user_item = json!({
        "id": user_item_id,
        "type": "message",
        "role": "user",
        "content": content
    });
    append_history_item_with_reconnect(&app, &state, user_item).await?;
    let references = history_references(&state.history_items).await;
    state
        .turn_references
        .lock()
        .await
        .insert(turn_id.clone(), references.clone());
    if image_count > 0 {
        state.pending_image_history.lock().await.insert(
            turn_id.clone(),
            ImageHistoryReplacement {
                image_item_id: user_item_id,
                replacement: message_item(
                    "user",
                    "input_text",
                    &format!(
                        "USER_TURN turn={turn_id}\n{}\n[{image_count} screenshot(s) were analyzed in this turn; their pixels are not retained in later Quick turns.]",
                        prompt.trim()
                    ),
                ),
            },
        );
    }
    send_response_with_reconnect(&app, &state, &turn_id, references).await
}

#[tauri::command]
pub async fn retry_realtime_turn(
    app: AppHandle,
    state: tauri::State<'_, RealtimeState>,
    turn_id: String,
) -> Result<(), String> {
    {
        let preparation = state.preparation_gate.lock().await;
        drop(preparation);
    }
    let references = state
        .turn_references
        .lock()
        .await
        .get(&turn_id)
        .cloned()
        .ok_or_else(|| format!("Quick turn is no longer available for retry: {turn_id}"))?;
    send_response_with_reconnect(&app, &state, &turn_id, references).await
}

#[tauri::command]
pub async fn close_realtime_session(state: tauri::State<'_, RealtimeState>) -> Result<(), String> {
    state.session_generation.fetch_add(1, Ordering::SeqCst);
    reset_connection(&state).await;
    state.history_items.lock().await.clear();
    state.turn_references.lock().await.clear();
    state.pending_image_history.lock().await.clear();
    *state.context_hash.lock().await = None;
    Ok(())
}

fn ensure_current_session(state: &RealtimeState, generation: u64) -> Result<(), String> {
    if state.session_generation.load(Ordering::SeqCst) != generation {
        return Err("Realtime session was closed".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn append_realtime_verified_answer(
    app: AppHandle,
    state: tauri::State<'_, RealtimeState>,
    turn_id: String,
    answer: String,
) -> Result<(), String> {
    if answer.trim().is_empty() {
        return Ok(());
    }
    {
        let preparation = state.preparation_gate.lock().await;
        drop(preparation);
    }
    append_history_item_with_reconnect(
        &app,
        &state,
        message_item(
            "system",
            "input_text",
            &format!("VERIFIED_CODEX_ANSWER turn={turn_id}\n{}", answer.trim()),
        ),
    )
    .await
}

async fn ensure_connection(app: &AppHandle, state: &RealtimeState) -> Result<Writer, String> {
    if state.ready.load(Ordering::Acquire) {
        if let Some(writer) = state.writer.lock().await.clone() {
            return Ok(writer);
        }
    }
    let _gate = state.connect_gate.lock().await;
    if state.ready.load(Ordering::Acquire) {
        if let Some(writer) = state.writer.lock().await.clone() {
            return Ok(writer);
        }
    }

    state.ready.store(false, Ordering::Release);
    if let Some(task) = state.reader_task.lock().await.take() {
        task.abort();
    }
    *state.writer.lock().await = None;

    let key = load_secret(Some(app), "OPENAI_API_KEY")?;
    let url = format!("wss://api.openai.com/v1/realtime?model={REALTIME_MODEL}");
    let mut request = url
        .into_client_request()
        .map_err(|error| error.to_string())?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| "OPENAI_API_KEY contains invalid header characters")?,
    );
    let (socket, _) = tokio::time::timeout(Duration::from_secs(8), connect_async(request))
        .await
        .map_err(|_| "OpenAI Realtime connection timed out".to_string())?
        .map_err(|error| format!("Failed to connect to OpenAI Realtime: {error}"))?;
    let (writer, reader) = socket.split();
    let writer = Arc::new(Mutex::new(writer));
    let (ready_sender, ready_receiver) = oneshot::channel();
    let ready = state.ready.clone();
    let task = tokio::spawn(read_loop(
        app.clone(),
        reader,
        writer.clone(),
        ready.clone(),
        ready_sender,
        state.history_gate.clone(),
        state.history_items.clone(),
        state.pending_image_history.clone(),
    ));

    let instructions = realtime_instructions(app);
    send_json(
        &writer,
        json!({
            "type": "session.update",
            "session": {
                "type": "realtime",
                "model": REALTIME_MODEL,
                "output_modalities": ["text"],
                "reasoning": {
                    "effort": "low"
                },
                "instructions": instructions,
                "tool_choice": "none"
            }
        }),
    )
    .await?;
    match tokio::time::timeout(Duration::from_secs(8), ready_receiver).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => {
            task.abort();
            return Err(error);
        }
        Ok(Err(_)) => {
            task.abort();
            return Err("OpenAI Realtime closed during setup".into());
        }
        Err(_) => {
            task.abort();
            return Err("OpenAI Realtime setup timed out".into());
        }
    }
    {
        let _history_gate = state.history_gate.lock().await;
        for item in state.history_items.lock().await.clone() {
            send_json(
                &writer,
                json!({ "type": "conversation.item.create", "item": item }),
            )
            .await?;
        }
    }
    *state.writer.lock().await = Some(writer.clone());
    *state.reader_task.lock().await = Some(task);
    let _ = app.emit("realtime-ready", REALTIME_MODEL);
    Ok(writer)
}

async fn send_response_with_reconnect(
    app: &AppHandle,
    state: &RealtimeState,
    turn_id: &str,
    references: Vec<Value>,
) -> Result<(), String> {
    let event = response_event(app, turn_id, references.clone());
    let writer = ensure_connection(app, state).await?;
    if send_json(&writer, event).await.is_ok() {
        return Ok(());
    }
    reset_connection(state).await;
    let writer = ensure_connection(app, state).await?;
    send_json(&writer, response_event(app, turn_id, references)).await
}

fn response_event(app: &AppHandle, turn_id: &str, references: Vec<Value>) -> Value {
    let instructions = realtime_instructions(app);
    json!({
        "type": "response.create",
        "response": {
            "conversation": "none",
            "input": references,
            "output_modalities": ["text"],
            "metadata": { "client_turn_id": turn_id },
            "instructions": instructions,
            "max_output_tokens": 700
        }
    })
}

async fn reset_connection(state: &RealtimeState) {
    state.ready.store(false, Ordering::Release);
    if let Some(task) = state.reader_task.lock().await.take() {
        task.abort();
    }
    if let Some(writer) = state.writer.lock().await.take() {
        let _ = writer.lock().await.close().await;
    }
}

async fn read_loop(
    app: AppHandle,
    mut reader: SplitStream<Socket>,
    writer: Writer,
    ready: Arc<AtomicBool>,
    ready_sender: oneshot::Sender<Result<(), String>>,
    history_gate: Arc<Mutex<()>>,
    history_items: Arc<Mutex<Vec<Value>>>,
    pending_image_history: Arc<Mutex<HashMap<String, ImageHistoryReplacement>>>,
) {
    let mut ready_sender = Some(ready_sender);
    let mut response_turns = HashMap::<String, String>::new();
    let mut response_text = HashMap::<String, String>::new();
    while let Some(message) = reader.next().await {
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                if let Some(sender) = ready_sender.take() {
                    let _ = sender.send(Err(error.to_string()));
                }
                let _ = app.emit(
                    "realtime-error",
                    RealtimeFailure {
                        turn_id: None,
                        message: error.to_string(),
                    },
                );
                break;
            }
        };
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("session.updated") => {
                ready.store(true, Ordering::Release);
                if let Some(sender) = ready_sender.take() {
                    let _ = sender.send(Ok(()));
                }
            }
            Some("response.created") => {
                if let (Some(response_id), Some(turn_id)) = (
                    event.pointer("/response/id").and_then(Value::as_str),
                    event
                        .pointer("/response/metadata/client_turn_id")
                        .and_then(Value::as_str),
                ) {
                    response_turns.insert(response_id.to_string(), turn_id.to_string());
                }
            }
            Some("response.output_text.delta") | Some("response.text.delta") => {
                let response_id = event
                    .get("response_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let delta = event
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(turn_id) = response_turns.get(response_id) {
                    response_text
                        .entry(response_id.to_string())
                        .or_default()
                        .push_str(delta);
                    let _ = app.emit(
                        "realtime-answer-delta",
                        RealtimeDelta {
                            turn_id: turn_id.clone(),
                            delta: delta.to_string(),
                        },
                    );
                }
            }
            Some("response.done") => {
                let response_id = event
                    .pointer("/response/id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(turn_id) = response_turns.remove(response_id) {
                    let text = response_text
                        .remove(response_id)
                        .unwrap_or_else(|| response_output_text(&event));
                    let response_status = event
                        .pointer("/response/status")
                        .and_then(Value::as_str)
                        .unwrap_or("completed");
                    if response_status != "completed" || text.trim().is_empty() {
                        let detail = event
                            .pointer("/response/status_details/error/message")
                            .and_then(Value::as_str)
                            .or_else(|| {
                                event
                                    .pointer("/response/status_details/reason")
                                    .and_then(Value::as_str)
                            })
                            .unwrap_or(if text.trim().is_empty() {
                                "Realtime returned no text"
                            } else {
                                "Realtime response did not complete"
                            });
                        let _ = app.emit(
                            "realtime-error",
                            RealtimeFailure {
                                turn_id: Some(turn_id),
                                message: format!("{detail} ({response_status})"),
                            },
                        );
                        continue;
                    }
                    let _ = app.emit(
                        "realtime-answer-done",
                        RealtimeDone {
                            turn_id: turn_id.clone(),
                            text: text.clone(),
                        },
                    );
                    compact_completed_image_turn(
                        &writer,
                        &history_gate,
                        &history_items,
                        &pending_image_history,
                        &turn_id,
                    )
                    .await;
                    if !text.trim().is_empty() {
                        let _gate = history_gate.lock().await;
                        if let Err(message) = append_history_item(
                            &writer,
                            &history_items,
                            message_item(
                                "assistant",
                                "output_text",
                                &format!("QUICK_ANSWER turn={turn_id}\n{}", text.trim()),
                            ),
                        )
                        .await
                        {
                            let _ = app.emit(
                                "realtime-error",
                                RealtimeFailure {
                                    turn_id: Some(turn_id),
                                    message,
                                },
                            );
                        }
                    }
                }
            }
            Some("error") => {
                let message = event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("OpenAI Realtime error")
                    .to_string();
                let response_id = event
                    .get("response_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let turn_id = response_turns.remove(response_id);
                if let Some(sender) = ready_sender.take() {
                    let _ = sender.send(Err(message.clone()));
                }
                let _ = app.emit("realtime-error", RealtimeFailure { turn_id, message });
            }
            _ => {}
        }
    }
    ready.store(false, Ordering::Release);
}

async fn compact_completed_image_turn(
    writer: &Writer,
    history_gate: &Arc<Mutex<()>>,
    history_items: &Arc<Mutex<Vec<Value>>>,
    pending: &Arc<Mutex<HashMap<String, ImageHistoryReplacement>>>,
    turn_id: &str,
) {
    let Some(entry) = pending.lock().await.remove(turn_id) else {
        return;
    };
    let _gate = history_gate.lock().await;
    if append_history_item(writer, history_items, entry.replacement.clone())
        .await
        .is_err()
    {
        pending.lock().await.insert(turn_id.to_string(), entry);
        return;
    }
    history_items.lock().await.retain(|item| {
        item.get("id").and_then(Value::as_str) != Some(entry.image_item_id.as_str())
    });
}

async fn append_history_item(
    writer: &Writer,
    history_items: &Arc<Mutex<Vec<Value>>>,
    item: Value,
) -> Result<(), String> {
    send_json(
        writer,
        json!({ "type": "conversation.item.create", "item": item.clone() }),
    )
    .await?;
    history_items.lock().await.push(item);
    Ok(())
}

async fn append_history_item_with_reconnect(
    app: &AppHandle,
    state: &RealtimeState,
    item: Value,
) -> Result<(), String> {
    let writer = ensure_connection(app, state).await?;
    let gate = state.history_gate.lock().await;
    let first = append_history_item(&writer, &state.history_items, item.clone()).await;
    drop(gate);
    if first.is_ok() {
        return Ok(());
    }
    reset_connection(state).await;
    let writer = ensure_connection(app, state).await?;
    let _gate = state.history_gate.lock().await;
    append_history_item(&writer, &state.history_items, item).await
}

async fn history_references(history_items: &Arc<Mutex<Vec<Value>>>) -> Vec<Value> {
    history_items
        .lock()
        .await
        .iter()
        .filter_map(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(|id| json!({ "type": "item_reference", "id": id }))
        })
        .collect()
}

fn message_item(role: &str, content_type: &str, text: &str) -> Value {
    json!({
        "id": item_id(role),
        "type": "message",
        "role": role,
        "content": [{ "type": content_type, "text": text }]
    })
}

fn item_id(prefix: &str) -> String {
    let uuid = Uuid::new_v4().simple().to_string();
    format!("item_{prefix}_{}", &uuid[..16])
}

async fn image_path_to_data_url(path: &str) -> Result<String, String> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("Failed to read screenshot {path}: {error}"))?;
    let mime = match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        _ => return Err(format!("Unsupported screenshot format: {path}")),
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

async fn send_json(writer: &Writer, value: Value) -> Result<(), String> {
    writer
        .lock()
        .await
        .send(Message::Text(value.to_string().into()))
        .await
        .map_err(|error| format!("OpenAI Realtime send failed: {error}"))
}

fn response_output_text(event: &Value) -> String {
    event
        .pointer("/response/output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<String>()
}

pub fn configured_openai_key() -> Result<String, String> {
    load_secret(None, "OPENAI_API_KEY")
}
