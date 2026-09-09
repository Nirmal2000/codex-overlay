use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderValue, Response, StatusCode},
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{mpsc, Mutex, RwLock};

const REMOTE_INDEX: &str = include_str!("../remote/index.html");
const REMOTE_APP: &str = include_str!("../remote/app.js");
const REMOTE_GESTURES: &str = include_str!("../remote/controller-gestures.mjs");
const REMOTE_STYLES: &str = include_str!("../remote/styles.css");
const REMOTE_MANIFEST: &str = include_str!("../remote/manifest.webmanifest");
const REMOTE_SERVICE_WORKER: &str = include_str!("../remote/sw.js");
const REMOTE_ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");
const MAX_SCROLL_DELTA: f64 = 800.0;
const SCROLL_OWNER_TIMEOUT: Duration = Duration::from_millis(450);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClientRole {
    Display,
    Controller,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBridgeInfo {
    pub url: String,
    pub websocket_url: String,
    pub port: u16,
    pub connected_clients: usize,
}

#[derive(Clone)]
struct ClientHandle {
    role: ClientRole,
    tx: mpsc::UnboundedSender<String>,
}

struct ScrollOwner {
    client_id: u64,
    gesture_id: u64,
    last_at: Instant,
}

struct RemoteInner {
    snapshot: RwLock<Option<Value>>,
    clients: Mutex<HashMap<u64, ClientHandle>>,
    next_client_id: AtomicU64,
    sequence: AtomicU64,
    connected_clients: AtomicUsize,
    display_clients: AtomicUsize,
    controller_clients: AtomicUsize,
    scroll_owner: Mutex<Option<ScrollOwner>>,
}

impl Default for RemoteInner {
    fn default() -> Self {
        Self {
            snapshot: RwLock::new(None),
            clients: Mutex::new(HashMap::new()),
            next_client_id: AtomicU64::new(1),
            sequence: AtomicU64::new(0),
            connected_clients: AtomicUsize::new(0),
            display_clients: AtomicUsize::new(0),
            controller_clients: AtomicUsize::new(0),
            scroll_owner: Mutex::new(None),
        }
    }
}

pub struct RemoteBridgeState {
    inner: Arc<RemoteInner>,
    server: Mutex<Option<RemoteBridgeInfo>>,
}

impl Default for RemoteBridgeState {
    fn default() -> Self {
        Self {
            inner: Arc::new(RemoteInner::default()),
            server: Mutex::new(None),
        }
    }
}

#[derive(Clone)]
struct WebState {
    app: AppHandle,
    inner: Arc<RemoteInner>,
}

#[tauri::command]
pub async fn start_remote_bridge(
    app: AppHandle,
    state: tauri::State<'_, RemoteBridgeState>,
) -> Result<RemoteBridgeInfo, String> {
    let mut server = state.server.lock().await;
    if let Some(info) = server.as_ref() {
        let mut current = info.clone();
        current.connected_clients = state.inner.connected_clients.load(Ordering::Acquire);
        return Ok(current);
    }

    let (listener, port) = bind_listener().await?;
    let ip = local_ip().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let info = RemoteBridgeInfo {
        url: format!("http://{ip}:{port}/"),
        websocket_url: format!("ws://{ip}:{port}/ws"),
        port,
        connected_clients: 0,
    };
    let web_state = WebState {
        app: app.clone(),
        inner: state.inner.clone(),
    };
    let router = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/controller-gestures.mjs", get(gestures_js))
        .route("/styles.css", get(styles))
        .route("/manifest.webmanifest", get(manifest))
        .route("/sw.js", get(service_worker))
        .route("/icon.png", get(icon))
        .route("/health", get(health))
        .route("/ws", get(websocket))
        .with_state(web_state);

    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            let _ = app.emit("remote-bridge-error", error.to_string());
        }
    });
    *server = Some(info.clone());
    Ok(info)
}

#[tauri::command]
pub async fn get_remote_bridge_info(
    state: tauri::State<'_, RemoteBridgeState>,
) -> Result<Option<RemoteBridgeInfo>, String> {
    Ok(state.server.lock().await.as_ref().map(|info| {
        let mut current = info.clone();
        current.connected_clients = state.inner.connected_clients.load(Ordering::Acquire);
        current
    }))
}

#[tauri::command]
pub async fn publish_remote_snapshot(
    state: tauri::State<'_, RemoteBridgeState>,
    snapshot: Value,
) -> Result<(), String> {
    *state.inner.snapshot.write().await = Some(snapshot.clone());
    fanout(&state.inner, "session.snapshot", snapshot).await
}

pub fn broadcast_scroll<R: Runtime>(app: &AppHandle<R>, action: &str) {
    let state = app.state::<RemoteBridgeState>();
    let inner = state.inner.clone();
    let action = action.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = fanout(&inner, "scroll.command", json!({ "action": action })).await;
    });
}

async fn fanout(inner: &RemoteInner, event_type: &str, payload: Value) -> Result<(), String> {
    let sequence = inner.sequence.fetch_add(1, Ordering::SeqCst) + 1;
    let counts = client_counts(inner);
    let clients = inner.clients.lock().await.clone();
    for client in clients.values() {
        if event_type.starts_with("controller.scroll") && client.role != ClientRole::Display {
            continue;
        }
        if event_type == "scroll.command" && client.role != ClientRole::Display {
            continue;
        }
        let next_payload = if event_type == "session.snapshot" && client.role == ClientRole::Controller
        {
            controller_snapshot(&payload, counts)
        } else if event_type == "session.snapshot" && client.role == ClientRole::Display {
            with_counts(payload.clone(), counts)
        } else {
            payload.clone()
        };
        let envelope = serde_json::to_string(&json!({
            "type": event_type,
            "sequence": sequence,
            "payload": next_payload,
        }))
        .map_err(|error| error.to_string())?;
        let _ = client.tx.send(envelope);
    }
    Ok(())
}

fn client_counts(inner: &RemoteInner) -> (usize, usize) {
    (
        inner.display_clients.load(Ordering::Acquire),
        inner.controller_clients.load(Ordering::Acquire),
    )
}

fn with_counts(mut payload: Value, counts: (usize, usize)) -> Value {
    if let Some(object) = payload.as_object_mut() {
        object.insert("connectedDisplays".into(), json!(counts.0));
        object.insert("connectedControllers".into(), json!(counts.1));
    }
    payload
}

pub(crate) fn parse_client_role(value: Option<&str>) -> ClientRole {
    match value {
        Some("controller") => ClientRole::Controller,
        _ => ClientRole::Display,
    }
}

pub(crate) fn clamp_scroll_delta(value: Option<f64>) -> Option<f64> {
    let delta = value?;
    if !delta.is_finite() {
        return None;
    }
    Some(delta.clamp(-MAX_SCROLL_DELTA, MAX_SCROLL_DELTA))
}

pub(crate) fn controller_snapshot(payload: &Value, counts: (usize, usize)) -> Value {
    json!({
        "lifecycle": payload.get("lifecycle").cloned().unwrap_or_else(|| json!(if payload.get("started").and_then(Value::as_bool).unwrap_or(false) { "active" } else { "idle" })),
        "started": payload.get("started").and_then(Value::as_bool).unwrap_or(false),
        "mode": payload.get("mode").cloned().unwrap_or(Value::Null),
        "busy": payload.get("busy").and_then(Value::as_bool).unwrap_or(false),
        "canSend": payload.get("canSend").and_then(Value::as_bool).unwrap_or(false),
        "connectedDisplays": counts.0,
        "connectedControllers": counts.1,
    })
}

pub(crate) fn authorized_controller_action(action: &str) -> bool {
    matches!(action, "send" | "stop_send")
}

async fn bind_listener() -> Result<(tokio::net::TcpListener, u16), String> {
    for port in 4317..=4327 {
        if let Ok(listener) = tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await {
            return Ok((listener, port));
        }
    }
    Err("No available remote-view port between 4317 and 4327".into())
}

fn local_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect("1.1.1.1:80").ok()?;
    Some(socket.local_addr().ok()?.ip())
}

async fn websocket(ws: WebSocketUpgrade, State(state): State<WebState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: WebState) {
    let client_id = state.inner.next_client_id.fetch_add(1, Ordering::SeqCst);
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let mut role = ClientRole::Display;
    let mut registered = false;

    let count = state
        .inner
        .connected_clients
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let _ = state.app.emit("remote-client-count", count);

    loop {
        tokio::select! {
            outbound = rx.recv() => {
                match outbound {
                    Some(event) => {
                        if sender.send(Message::Text(event.into())).await.is_err() { break; }
                    }
                    None => break,
                }
            }
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Text(message))) => {
                        let Some(value) = serde_json::from_str::<Value>(message.as_str()).ok() else { continue };
                        match value.get("type").and_then(Value::as_str) {
                            Some("client.hello") => {
                                let next_role = parse_client_role(value.get("role").and_then(Value::as_str));
                                register_client(&state, client_id, next_role, tx.clone(), registered, role).await;
                                role = next_role;
                                registered = true;
                                if let Some(snapshot) = state.inner.snapshot.read().await.clone() {
                                    let counts = client_counts(&state.inner);
                                    let payload = if role == ClientRole::Controller {
                                        controller_snapshot(&snapshot, counts)
                                    } else {
                                        with_counts(snapshot, counts)
                                    };
                                    let sequence = state.inner.sequence.fetch_add(1, Ordering::SeqCst) + 1;
                                    let envelope = json!({
                                        "type": "session.snapshot",
                                        "sequence": sequence,
                                        "payload": payload,
                                    }).to_string();
                                    if sender.send(Message::Text(envelope.into())).await.is_err() { break; }
                                }
                            }
                            Some("controller.scroll") | Some("controller.scroll_end") | Some("controller.jump_latest") => {
                                if role != ClientRole::Controller {
                                    continue;
                                }
                                handle_controller_scroll(&state, client_id, &value).await;
                            }
                            Some("control.command") => handle_control_command(&state, role, &value),
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    unregister_client(&state, client_id, registered, role).await;
}

async fn register_client(
    state: &WebState,
    client_id: u64,
    role: ClientRole,
    tx: mpsc::UnboundedSender<String>,
    already_registered: bool,
    previous_role: ClientRole,
) {
    if already_registered {
        adjust_role_count(&state.inner, previous_role, -1);
    }
    adjust_role_count(&state.inner, role, 1);
    state.inner.clients.lock().await.insert(
        client_id,
        ClientHandle {
            role,
            tx,
        },
    );
    let _ = state.app.emit(
        "remote-client-count",
        state.inner.connected_clients.load(Ordering::Acquire),
    );
}

async fn unregister_client(state: &WebState, client_id: u64, registered: bool, role: ClientRole) {
    state.inner.clients.lock().await.remove(&client_id);
    if registered {
        adjust_role_count(&state.inner, role, -1);
    }
    let mut owner = state.inner.scroll_owner.lock().await;
    if owner.as_ref().is_some_and(|current| current.client_id == client_id) {
        *owner = None;
    }
    let previous = state
        .inner
        .connected_clients
        .fetch_sub(1, Ordering::SeqCst);
    let count = previous.saturating_sub(1);
    let _ = state.app.emit("remote-client-count", count);
}

fn adjust_role_count(inner: &RemoteInner, role: ClientRole, delta: isize) {
    let counter = match role {
        ClientRole::Display => &inner.display_clients,
        ClientRole::Controller => &inner.controller_clients,
    };
    if delta >= 0 {
        counter.fetch_add(delta as usize, Ordering::SeqCst);
    } else {
        let previous = counter.load(Ordering::Acquire);
        counter.store(previous.saturating_sub((-delta) as usize), Ordering::Release);
    }
}

async fn handle_controller_scroll(state: &WebState, client_id: u64, value: &Value) {
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or_default();
    if event_type == "controller.jump_latest" {
        *state.inner.scroll_owner.lock().await = None;
        let _ = fanout(&state.inner, "controller.jump_latest", json!({})).await;
        return;
    }
    let Some(gesture_id) = value.get("gestureId").and_then(Value::as_u64) else {
        return;
    };
    if !claim_scroll_owner(&state.inner, client_id, gesture_id, event_type == "controller.scroll_end").await {
        return;
    }
    if event_type == "controller.scroll_end" {
        let _ = fanout(
            &state.inner,
            "controller.scroll_end",
            json!({ "gestureId": gesture_id }),
        )
        .await;
        return;
    }
    let Some(delta_y) = clamp_scroll_delta(value.get("deltaY").and_then(Value::as_f64)) else {
        return;
    };
    if delta_y == 0.0 {
        return;
    }
    let _ = fanout(
        &state.inner,
        "controller.scroll",
        json!({
            "deltaY": delta_y,
            "gestureId": gesture_id,
        }),
    )
    .await;
}

async fn claim_scroll_owner(
    inner: &RemoteInner,
    client_id: u64,
    gesture_id: u64,
    ending: bool,
) -> bool {
    let mut owner = inner.scroll_owner.lock().await;
    let now = Instant::now();
    let allowed = match owner.as_ref() {
        None => true,
        Some(current) if current.client_id == client_id && current.gesture_id == gesture_id => true,
        Some(current) if now.duration_since(current.last_at) >= SCROLL_OWNER_TIMEOUT => true,
        Some(current) if current.client_id == client_id && ending => true,
        _ => false,
    };
    if !allowed {
        return false;
    }
    if ending {
        *owner = None;
    } else {
        *owner = Some(ScrollOwner {
            client_id,
            gesture_id,
            last_at: now,
        });
    }
    true
}

fn handle_control_command(state: &WebState, role: ClientRole, value: &Value) {
    let Some(action) = value.get("action").and_then(Value::as_str) else {
        return;
    };
    if role == ClientRole::Controller && !authorized_controller_action(action) {
        return;
    }
    if !matches!(
        action,
        "send"
            | "stop_send"
            | "screenshot"
            | "retry_failed"
            | "select_model"
            | "start_session"
            | "end_session"
    ) {
        return;
    }
    let model_key = value.get("modelKey").and_then(Value::as_str);
    let selection = value
        .get("provider")
        .and_then(Value::as_str)
        .zip(value.get("model").and_then(Value::as_str));
    if action == "select_model" && model_key.is_none()
        && !matches!(
            selection,
            Some(
                ("openai-codex", "gpt-5.6-terra")
                    | ("openai-codex", "gpt-5.6-sol")
                    | ("cursor", "gpt-5.6-terra@272k:fast")
                    | ("cursor", "grok-4.6:fast")
                    | ("xai", "grok-4.5")
                    | ("xai", "grok-4.6")
                    | ("openrouter", "openai/gpt-5.6-terra")
                    | ("openrouter", "z-ai/glm-5.3-flash")
            )
        )
    {
        return;
    }
    let payload = if let Some(model_key) = model_key {
        json!({ "action": action, "modelKey": model_key })
    } else {
        match selection {
            Some((provider @ "openai-codex", model @ "gpt-5.6-terra"))
            | Some((provider @ "openai-codex", model @ "gpt-5.6-sol"))
            | Some((provider @ "cursor", model @ "gpt-5.6-terra@272k:fast"))
            | Some((provider @ "cursor", model @ "grok-4.6:fast"))
            | Some((provider @ "xai", model @ "grok-4.5"))
            | Some((provider @ "xai", model @ "grok-4.6"))
            | Some((provider @ "openrouter", model @ "openai/gpt-5.6-terra"))
            | Some((provider @ "openrouter", model @ "z-ai/glm-5.3-flash")) => {
                json!({ "action": action, "provider": provider, "model": model })
            }
            _ => json!({ "action": action }),
        }
    };
    let _ = state.app.emit("remote-control", payload);
}

async fn index() -> Html<&'static str> {
    Html(REMOTE_INDEX)
}

async fn app_js() -> Response<Body> {
    static_response(REMOTE_APP.as_bytes(), "text/javascript; charset=utf-8")
}

async fn gestures_js() -> Response<Body> {
    static_response(REMOTE_GESTURES.as_bytes(), "text/javascript; charset=utf-8")
}

async fn styles() -> Response<Body> {
    static_response(REMOTE_STYLES.as_bytes(), "text/css; charset=utf-8")
}

async fn manifest() -> Response<Body> {
    static_response(
        REMOTE_MANIFEST.as_bytes(),
        "application/manifest+json; charset=utf-8",
    )
}

async fn service_worker() -> Response<Body> {
    static_response(REMOTE_SERVICE_WORKER.as_bytes(), "text/javascript; charset=utf-8")
}

async fn icon() -> Response<Body> {
    static_response(REMOTE_ICON, "image/png")
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

fn static_response(bytes: &'static [u8], content_type: &'static str) -> Response<Body> {
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_roles_become_display() {
        assert_eq!(parse_client_role(Some("controller")), ClientRole::Controller);
        assert_eq!(parse_client_role(Some("display")), ClientRole::Display);
        assert_eq!(parse_client_role(Some("admin")), ClientRole::Display);
        assert_eq!(parse_client_role(None), ClientRole::Display);
    }

    #[test]
    fn clamps_and_rejects_invalid_scroll_deltas() {
        assert_eq!(clamp_scroll_delta(Some(12.5)), Some(12.5));
        assert_eq!(clamp_scroll_delta(Some(2_000.0)), Some(800.0));
        assert_eq!(clamp_scroll_delta(Some(-2_000.0)), Some(-800.0));
        assert_eq!(clamp_scroll_delta(Some(f64::NAN)), None);
        assert_eq!(clamp_scroll_delta(None), None);
    }

    #[test]
    fn controller_snapshots_strip_private_fields() {
        let payload = json!({
            "lifecycle": "active",
            "started": true,
            "mode": "webapp",
            "busy": false,
            "canSend": true,
            "messages": [{ "content": "secret" }],
            "liveTranscript": { "text": "private" },
            "piSelection": { "key": "x" },
        });
        let filtered = controller_snapshot(&payload, (2, 1));
        assert_eq!(filtered["connectedDisplays"], 2);
        assert_eq!(filtered["connectedControllers"], 1);
        assert!(filtered.get("messages").is_none());
        assert!(filtered.get("liveTranscript").is_none());
        assert!(filtered.get("piSelection").is_none());
    }

    #[test]
    fn controllers_may_only_send_or_stop_send() {
        assert!(authorized_controller_action("send"));
        assert!(authorized_controller_action("stop_send"));
        assert!(!authorized_controller_action("select_model"));
        assert!(!authorized_controller_action("start_session"));
        assert!(!authorized_controller_action("screenshot"));
    }
}
