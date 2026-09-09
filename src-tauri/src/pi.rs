use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::context::{build_prompt_context, ContextInfo, ContextKind};
use crate::credentials::load_secret;
use crate::prompts::pi_instructions;

type BridgeReply = Result<Value, String>;

const DEFAULT_PI_PROVIDER: &str = "openai-codex";
const DEFAULT_PI_MODEL: &str = "gpt-5.6-terra";
const PI_THINKING_LEVEL: &str = "low";
const START_TIMEOUT: Duration = Duration::from_secs(30);
const CURSOR_START_TIMEOUT: Duration = Duration::from_secs(90);
const TURN_TIMEOUT: Duration = Duration::from_secs(190);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);

pub struct PiState {
    workspace: Mutex<Option<PathBuf>>,
    context_hash: Mutex<Option<String>>,
    selection: Mutex<Option<(String, String, String)>>,
    transport: AsyncMutex<Option<Transport>>,
    start_gate: AsyncMutex<()>,
    ready: Arc<AtomicBool>,
    next_id: AtomicU64,
    pending: Arc<AsyncMutex<HashMap<u64, oneshot::Sender<BridgeReply>>>>,
}

struct Transport {
    child: Child,
    stdin: Arc<AsyncMutex<ChildStdin>>,
    reader_done: oneshot::Receiver<()>,
}

impl Default for PiState {
    fn default() -> Self {
        Self {
            workspace: Mutex::new(None),
            context_hash: Mutex::new(None),
            selection: Mutex::new(None),
            transport: AsyncMutex::new(None),
            start_gate: AsyncMutex::new(()),
            ready: Arc::new(AtomicBool::new(false)),
            next_id: AtomicU64::new(1),
            pending: Arc::new(AsyncMutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone, Serialize)]
struct PreparationStatus {
    phase: String,
    message: String,
    context: Option<ContextInfo>,
}

#[tauri::command]
pub async fn start_pi_session(
    app: AppHandle,
    state: tauri::State<'_, PiState>,
    workspace: String,
    provider: String,
    model: String,
    thinking_level: Option<String>,
    nitro: Option<bool>,
    direct_context: String,
) -> Result<ContextInfo, String> {
    let thinking_level = thinking_level.unwrap_or_else(|| PI_THINKING_LEVEL.to_string());
    validate_selection(&provider, &model, &thinking_level)?;
    let nitro =
        nitro.unwrap_or(false) || (provider == "openrouter" && model == "openai/gpt-5.6-terra");
    let path = PathBuf::from(&workspace);
    if !path.is_dir() {
        return Err("Workspace directory does not exist".into());
    }
    let pack = build_prompt_context(&direct_context, ContextKind::Pi);
    let same_session = state.ready.load(Ordering::Acquire)
        && state
            .workspace
            .lock()
            .map_err(|_| "Workspace lock failed")?
            .as_ref()
            == Some(&path)
        && state
            .context_hash
            .lock()
            .map_err(|_| "Context lock failed")?
            .as_deref()
            == Some(&pack.info.hash)
        && state
            .selection
            .lock()
            .map_err(|_| "Pi selection lock failed")?
            .as_ref()
            == Some(&(provider.clone(), model.clone(), thinking_level.clone()));
    if same_session {
        emit_preparation(
            &app,
            "ready",
            "Pi context already loaded",
            Some(pack.info.clone()),
        );
        return Ok(pack.info);
    }

    emit_preparation(
        &app,
        "preparing",
        "Starting Pi agent",
        Some(pack.info.clone()),
    );
    ensure_bridge(&app, &state).await?;
    state.ready.store(false, Ordering::Release);
    let agent_dir = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME is unavailable")?
        .join(".pi/agent");
    let response = rpc(
        &state,
        json!({
            "type": "start",
            "workspace": workspace,
            "agentDir": agent_dir,
            "instructions": pi_instructions(&app),
            "context": pack.text,
            "provider": provider,
            "model": model,
            "thinkingLevel": thinking_level,
            "nitro": nitro,
        }),
        start_timeout(&provider),
    )
    .await?;
    let session_id = response
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("pi-session");
    *state
        .workspace
        .lock()
        .map_err(|_| "Workspace lock failed")? = Some(path);
    *state
        .context_hash
        .lock()
        .map_err(|_| "Context lock failed")? = Some(pack.info.hash.clone());
    *state
        .selection
        .lock()
        .map_err(|_| "Pi selection lock failed")? = Some((provider, model, thinking_level));
    state.ready.store(true, Ordering::Release);
    let _ = app.emit("pi-session", session_id);
    emit_preparation(&app, "ready", "Pi agent ready", Some(pack.info.clone()));
    Ok(pack.info)
}

fn worker_lost(error: &str) -> bool {
    error.contains("Pi SDK bridge stopped unexpectedly")
        || error.contains("Pi bridge is unavailable")
        || error.contains("Failed to write to Pi bridge")
        || error.contains("Pi bridge response channel closed")
}

async fn mark_worker_dead(state: &PiState) {
    state.ready.store(false, Ordering::Release);
    if let Some(transport) = state.transport.lock().await.take() {
        let _ = stop_transport(transport).await;
    }
    let _ = state.workspace.lock().map(|mut value| *value = None);
    let _ = state.context_hash.lock().map(|mut value| *value = None);
    let _ = state.selection.lock().map(|mut value| *value = None);
}

#[tauri::command]
pub async fn send_pi_turn(
    app: AppHandle,
    state: tauri::State<'_, PiState>,
    prompt: String,
    image_paths: Vec<String>,
) -> Result<(), String> {
    if prompt.trim().is_empty() && image_paths.is_empty() {
        return Err("Nothing to send".into());
    }
    if !state.ready.load(Ordering::Acquire) {
        return Err("Pi session is not ready".into());
    }
    let result = rpc(
        &state,
        json!({
            "type": "prompt",
            "prompt": prompt,
            "imagePaths": image_paths,
        }),
        TURN_TIMEOUT,
    )
    .await;
    match result {
        Ok(value) => {
            if value.get("aborted").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            Ok(())
        }
        Err(error) if error.contains("timed out") => {
            let _ = rpc(&state, json!({ "type": "abort" }), CONTROL_TIMEOUT).await;
            let _ = app.emit(
                "pi-event",
                json!({ "event": "error", "message": &error }).to_string(),
            );
            Err(error)
        }
        Err(error) if worker_lost(&error) => {
            mark_worker_dead(&state).await;
            let _ = app.emit(
                "pi-event",
                json!({ "event": "error", "message": &error }).to_string(),
            );
            Err(error)
        }
        Err(error) => {
            let _ = app.emit(
                "pi-event",
                json!({ "event": "error", "message": &error }).to_string(),
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn stop_pi_turn(state: tauri::State<'_, PiState>) -> Result<bool, String> {
    if !state.ready.load(Ordering::Acquire) {
        return Ok(false);
    }
    let result = rpc(&state, json!({ "type": "abort" }), CONTROL_TIMEOUT).await?;
    Ok(result
        .get("aborted")
        .and_then(Value::as_bool)
        .unwrap_or(true))
}

#[tauri::command]
pub async fn close_pi_session(state: tauri::State<'_, PiState>) -> Result<(), String> {
    if state.ready.load(Ordering::Acquire) {
        let _ = rpc(&state, json!({ "type": "close" }), CONTROL_TIMEOUT).await;
    }
    state.ready.store(false, Ordering::Release);
    if let Some(transport) = state.transport.lock().await.take() {
        let _ = stop_transport(transport).await;
    }
    *state
        .workspace
        .lock()
        .map_err(|_| "Workspace lock failed")? = None;
    *state
        .context_hash
        .lock()
        .map_err(|_| "Context lock failed")? = None;
    *state
        .selection
        .lock()
        .map_err(|_| "Pi selection lock failed")? = None;
    state.pending.lock().await.clear();
    Ok(())
}

#[cfg(test)]
mod worker_lost_tests {
    use super::worker_lost;

    #[test]
    fn abort_and_timeout_are_not_worker_death() {
        assert!(!worker_lost("Pi turn stopped after its activity deadline"));
        assert!(!worker_lost("Pi bridge timed out after 190 seconds"));
        assert!(!worker_lost("Pi provider failed (stop reason: error)"));
    }

    #[test]
    fn process_exit_is_worker_death() {
        assert!(worker_lost("Pi SDK bridge stopped unexpectedly"));
        assert!(worker_lost("Pi bridge is unavailable"));
        assert!(worker_lost("Failed to write to Pi bridge: broken pipe"));
        assert!(worker_lost("Pi bridge response channel closed"));
    }
}

fn emit_preparation(app: &AppHandle, phase: &str, message: &str, context: Option<ContextInfo>) {
    let _ = app.emit(
        "pi-preparation-status",
        PreparationStatus {
            phase: phase.to_string(),
            message: message.to_string(),
            context,
        },
    );
}

fn start_timeout(provider: &str) -> Duration {
    if provider == "cursor" {
        CURSOR_START_TIMEOUT
    } else {
        START_TIMEOUT
    }
}

fn validate_selection(provider: &str, model: &str, thinking_level: &str) -> Result<(), String> {
    match (provider, model, thinking_level) {
        (DEFAULT_PI_PROVIDER, DEFAULT_PI_MODEL, "low")
        | ("openai-codex", "gpt-5.6-sol", "low")
        | ("cursor", "gpt-5.6-terra@272k:fast", "low")
        | ("cursor", "grok-4.6:fast", "medium")
        | ("xai", "grok-4.5", "low")
        | ("xai", "grok-4.6", "low")
        | ("openrouter", "openai/gpt-5.6-terra", "low")
        | ("openrouter", "z-ai/glm-5.3-flash", "low")
        | ("openrouter", "z-ai/glm-5.3-flash", "high")
        | ("openrouter", "z-ai/glm-5.3-flash", "max") => Ok(()),
        _ => Err(format!(
            "Unsupported Pi model selection: {provider}/{model} ({thinking_level})"
        )),
    }
}

async fn rpc(state: &PiState, mut command: Value, timeout: Duration) -> BridgeReply {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    command["id"] = json!(id);
    let (sender, receiver) = oneshot::channel();
    state.pending.lock().await.insert(id, sender);
    let stdin = state
        .transport
        .lock()
        .await
        .as_ref()
        .map(|transport| transport.stdin.clone())
        .ok_or("Pi bridge is unavailable")?;
    let line = serde_json::to_string(&command).map_err(|error| error.to_string())?;
    if let Err(error) = stdin
        .lock()
        .await
        .write_all(format!("{line}\n").as_bytes())
        .await
    {
        state.pending.lock().await.remove(&id);
        return Err(format!("Failed to write to Pi bridge: {error}"));
    }
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(reply)) => reply,
        Ok(Err(_)) => Err("Pi bridge response channel closed".into()),
        Err(_) => {
            state.pending.lock().await.remove(&id);
            Err(format!(
                "Pi bridge timed out after {} seconds",
                timeout.as_secs()
            ))
        }
    }
}

async fn ensure_bridge(app: &AppHandle, state: &PiState) -> Result<(), String> {
    let _gate = state.start_gate.lock().await;
    let stale_transport = {
        let mut transport = state.transport.lock().await;
        if let Some(existing) = transport.as_mut() {
            match existing.child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(_)) => {
                    state.ready.store(false, Ordering::Release);
                    transport.take()
                }
                Err(error) => return Err(format!("Failed to inspect Pi bridge: {error}")),
            }
        } else {
            None
        }
    };
    if let Some(transport) = stale_transport {
        stop_transport(transport).await?;
    }
    let node = resolve_node()?;
    let bridge = resolve_bridge(app)?;
    let mut command = Command::new(&node);
    command
        .arg(&bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Ok(resource_dir) = app.path().resource_dir() {
        let node_modules = resource_dir.join("node_modules");
        if node_modules.is_dir() {
            command.env("NODE_PATH", node_modules);
        }
    }
    if let Ok(key) = load_secret(Some(app), "CURSOR_API_KEY") {
        command.env("CURSOR_API_KEY", key);
    }
    if let Ok(key) = load_secret(Some(app), "OPENROUTER_API_KEY") {
        command.env("OPENROUTER_API_KEY", key);
    }
    let mut child = command.spawn()
        .map_err(|error| {
            format!(
                "Failed to start Pi SDK bridge with {}: {error}",
                node.display()
            )
        })?;
    let stdin = Arc::new(AsyncMutex::new(
        child.stdin.take().ok_or("Pi bridge stdin unavailable")?,
    ));
    let stdout = child.stdout.take().ok_or("Pi bridge stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Pi bridge stderr unavailable")?;
    let pending = state.pending.clone();
    let ready = state.ready.clone();
    let event_app = app.clone();
    let (reader_done_sender, reader_done) = oneshot::channel();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                eprintln!("Ignoring non-JSON Pi bridge output: {line}");
                continue;
            };
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if let Some(sender) = pending.lock().await.remove(&id) {
                    let reply = if message.get("ok").and_then(Value::as_bool) == Some(true) {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(message
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Pi bridge request failed")
                            .to_string())
                    };
                    let _ = sender.send(reply);
                }
            } else if message.get("event").is_some() {
                let _ = event_app.emit("pi-event", &line);
            }
        }
        ready.store(false, Ordering::Release);
        let mut pending = pending.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err("Pi SDK bridge stopped unexpectedly".into()));
        }
        let _ = reader_done_sender.send(());
    });
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("pi sdk: {line}");
        }
    });
    *state.transport.lock().await = Some(Transport {
        child,
        stdin,
        reader_done,
    });
    Ok(())
}

async fn stop_transport(mut transport: Transport) -> Result<(), String> {
    match transport.child.kill().await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {}
        Err(error) => return Err(format!("Failed to stop Pi worker: {error}")),
    }
    tokio::time::timeout(CONTROL_TIMEOUT, transport.reader_done)
        .await
        .map_err(|_| "Pi worker output did not close after it was stopped".to_string())?
        .map_err(|_| "Pi worker output task ended unexpectedly".to_string())
}

fn resolve_node() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("PI_NODE_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    [
        "/opt/homebrew/bin/node",
        "/opt/homebrew/opt/node@22/bin/node",
        "/opt/homebrew/opt/node@26/bin/node",
        "/usr/local/bin/node",
        "/usr/local/opt/node@22/bin/node",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
    .ok_or_else(|| "Pi requires Node.js 22.19 or newer; no supported Node binary was found".into())
}

fn resolve_bridge(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("PI_BRIDGE_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("pi-bridge/index.mjs");
    if bundled.is_file() {
        return Ok(bundled);
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../pi-bridge/index.mjs");
    source
        .is_file()
        .then_some(source)
        .ok_or_else(|| "Pi SDK bridge is missing".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::read_env_file_key;

    #[test]
    fn supports_openai_fast_models_with_low_reasoning() {
        assert_eq!(DEFAULT_PI_PROVIDER, "openai-codex");
        assert_eq!(DEFAULT_PI_MODEL, "gpt-5.6-terra");
        assert_eq!(PI_THINKING_LEVEL, "low");
        assert_eq!(start_timeout("openai-codex"), START_TIMEOUT);
        assert!(validate_selection("openai-codex", "gpt-5.6-terra", "low").is_ok());
        assert!(validate_selection("openai-codex", "gpt-5.6-sol", "low").is_ok());
        assert!(validate_selection("xai", "grok-4.5", "low").is_ok());
        assert!(validate_selection("xai", "grok-4.6", "low").is_ok());
    }

    #[test]
    fn supports_cursor_terra_fast() {
        assert!(validate_selection("cursor", "gpt-5.6-terra@272k:fast", "low").is_ok());
        assert!(validate_selection("cursor", "grok-4.6:fast", "medium").is_ok());
        assert!(validate_selection("cursor", "gpt-5.6-terra:fast", "low").is_err());
        assert!(validate_selection("cursor", "gpt-5.6-terra", "low").is_err());
        assert_eq!(start_timeout("cursor"), CURSOR_START_TIMEOUT);
    }

    #[test]
    fn supports_openrouter_glm_flash_modes() {
        assert!(validate_selection("openrouter", "z-ai/glm-5.3-flash", "low").is_ok());
        assert!(validate_selection("openrouter", "z-ai/glm-5.3-flash", "high").is_ok());
        assert!(validate_selection("openrouter", "z-ai/glm-5.3-flash", "max").is_ok());
        assert!(validate_selection("openrouter", "z-ai/glm-5.3-flash", "medium").is_err());
        assert!(validate_selection("openrouter", "openai/gpt-5.6-terra", "low").is_ok());
        assert!(validate_selection("openrouter", "openai/gpt-5.6-terra", "high").is_err());
    }

    #[test]
    fn reads_cursor_api_key_from_env_file_without_exposing_it() {
        let dir = std::env::temp_dir().join(format!("codex-overlay-cursor-env-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(&path, "CURSOR_API_KEY=crsr_test_local_key\n").unwrap();
        let key = read_env_file_key(&path, "CURSOR_API_KEY").expect("key should load");
        assert!(key.starts_with("crsr_"));
        assert_eq!(key.len(), "crsr_test_local_key".len());
        std::fs::remove_dir_all(&dir).ok();
    }
}
