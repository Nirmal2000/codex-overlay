use base64::Engine;
use codex_overlay_lib::context::{load_context, ContextKind};
use codex_overlay_lib::prompts::REALTIME_INSTRUCTIONS;
use codex_overlay_lib::realtime::{configured_openai_key, REALTIME_MODEL};
use futures_util::{SinkExt, StreamExt};
use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct LiveSession {
    socket: Socket,
    history: Vec<Value>,
}

struct LiveResponse {
    text: String,
    turn_id: Option<String>,
    saw_delta: bool,
    first_token_ms: u128,
}

#[tokio::test]
#[ignore = "extended live prompt evaluation; run explicitly to stay within API TPM limits"]
async fn live_production_prompt_is_fast_speakable_grounded_and_modality_aware() {
    let mut session = LiveSession::connect().await;
    let context_root = std::env::var("CODEX_OVERLAY_CONTEXT_ROOT")
        .expect("set CODEX_OVERLAY_CONTEXT_ROOT before running this ignored live test");
    let context = load_context(std::path::Path::new(&context_root), ContextKind::Realtime).unwrap();
    session
        .append_text(
            "system",
            "input_text",
            &format!(
                "REALTIME_CONTEXT_PACK version={} hash={}\n{}",
                context.info.version, context.info.hash, context.text
            ),
        )
        .await;

    let stale_url = session
        .ask_text("stale-url", "Manual input:\ngive me url let me check")
        .await;
    session.append_quick("stale-url", &stale_url.text).await;
    let introduction = session
        .ask_text(
            "introduction-after-url",
            "New transcript context since the previous turn:\n[You · live] Introduce myself.",
        )
        .await;
    let introduction_lower = introduction.text.to_lowercase();
    assert!(
        introduction_lower.contains("engineer")
            && introduction.text.split_whitespace().count() >= 25,
        "candidate cue did not produce an introduction: {}",
        introduction.text
    );
    assert!(
        !introduction_lower.contains("github.com") && !introduction_lower.contains("http"),
        "stale URL intent leaked into introduction: {}",
        introduction.text
    );
    assert_speakable(&introduction.text);
    session
        .append_quick("introduction-after-url", &introduction.text)
        .await;

    let coding = session
        .ask_text(
            "coding",
            "New transcript context since the previous turn:\n[Speaker · live] Explain how you would solve Two Sum while you begin coding it, including complexity and edge cases.",
        )
        .await;
    let coding_lower = coding.text.to_lowercase();
    assert!(
        coding_lower.contains("hash") || coding_lower.contains("map"),
        "missing coding approach: {}",
        coding.text
    );
    assert!(
        coding_lower.contains("o(n)"),
        "missing complexity: {}",
        coding.text
    );
    assert!(
        coding.text.contains("```") && coding_lower.contains("def "),
        "coding request did not include complete Python code: {}",
        coding.text
    );
    assert_speakable(&coding.text);
}

fn assert_speakable(text: &str) {
    let lower = text.to_lowercase();
    for forbidden in [
        "you can say",
        "as an ai",
        "provisional answer",
        "quick lane",
    ] {
        assert!(
            !lower.contains(forbidden),
            "non-speakable phrase {forbidden:?}: {text}"
        );
    }
    assert!(!text.trim().is_empty());
}

#[tokio::test]
async fn live_realtime_covers_context_verified_history_image_and_reconnect() {
    let mut session = LiveSession::connect().await;
    let context_code = format!("CTX-{}", &Uuid::new_v4().simple().to_string()[..10]);
    session
        .append_text(
            "system",
            "input_text",
            &format!(
        "REALTIME_CONTEXT_PACK\nThe harmless demo project's exact codename is {context_code}."
    ),
        )
        .await;

    let first = session
        .ask_text(
            "context-turn",
            "Reply with only the demo project's exact codename from the context pack.",
        )
        .await;
    assert!(first.saw_delta, "expected streamed text deltas");
    assert_eq!(first.turn_id.as_deref(), Some("context-turn"));
    assert!(
        first.text.contains(&context_code),
        "context was not retained: {}",
        first.text
    );
    session.append_quick("context-turn", &first.text).await;

    let verified_code = format!("VER-{}", &Uuid::new_v4().simple().to_string()[..10]);
    session.append_text("system", "input_text", &format!(
        "VERIFIED_CODEX_ANSWER turn=verified-source\nThe authoritative verification code is {verified_code}."
    )).await;
    let verified = session
        .ask_text(
            "verified-turn",
            "Reply only with the authoritative verification code from VERIFIED_CODEX_ANSWER.",
        )
        .await;
    assert!(
        verified.text.contains(&verified_code),
        "verified history was not used: {}",
        verified.text
    );
    session.append_quick("verified-turn", &verified.text).await;

    let image_response = session.ask(
        "image-turn",
        vec![
            json!({ "type": "input_text", "text": "Inspect the attached image, then reply exactly IMAGE_OK." }),
            json!({ "type": "input_image", "image_url": test_image_data_url(), "detail": "auto" }),
        ],
    ).await;
    assert!(
        image_response.text.contains("IMAGE_OK"),
        "image input failed: {}",
        image_response.text
    );

    let history = session.history.clone();
    session.socket.close(None).await.unwrap();
    let mut reconnected = LiveSession::connect().await;
    for item in history {
        reconnected.append_existing(item).await;
    }
    let recall = reconnected.ask_text(
        "reconnect-turn",
        "After reconnect, reply with the demo codename, a space, then the authoritative verification code.",
    ).await;
    assert!(
        recall.text.contains(&context_code),
        "reconnect lost context: {}",
        recall.text
    );
    assert!(
        recall.text.contains(&verified_code),
        "reconnect lost verified history: {}",
        recall.text
    );
}

#[tokio::test]
async fn live_realtime_runs_back_to_back_turns_in_parallel_without_cancellation() {
    let mut session = LiveSession::connect().await;
    let started = Instant::now();
    session
        .append_user(vec![
            json!({ "type": "input_text", "text": "Reply exactly RAPID_ONE." }),
        ])
        .await;
    let first_snapshot = session.references();
    session
        .create_response_with("rapid-one", first_snapshot.clone())
        .await;
    session
        .append_user(vec![
            json!({ "type": "input_text", "text": "Reply exactly RAPID_TWO." }),
        ])
        .await;
    session.create_response("rapid-two").await;

    let responses = collect_responses(&mut session.socket, 2, started).await;
    let by_turn: HashMap<_, _> = responses
        .into_iter()
        .map(|response| {
            (
                response.turn_id.clone().expect("response metadata missing"),
                response,
            )
        })
        .collect();
    assert!(
        by_turn["rapid-one"].text.contains("RAPID_ONE"),
        "first response used the wrong input: {}",
        by_turn["rapid-one"].text
    );
    assert!(
        !by_turn["rapid-one"].text.contains("RAPID_TWO"),
        "first response leaked the later turn: {}",
        by_turn["rapid-one"].text
    );
    assert!(
        by_turn["rapid-two"].text.contains("RAPID_TWO"),
        "second response used the wrong input: {}",
        by_turn["rapid-two"].text
    );

    session
        .create_response_with("rapid-one-retry", first_snapshot)
        .await;
    let retried = collect_responses(&mut session.socket, 1, Instant::now())
        .await
        .remove(0);
    assert!(
        retried.text.contains("RAPID_ONE") && !retried.text.contains("RAPID_TWO"),
        "retried response did not preserve its immutable input: {}",
        retried.text
    );
}

impl LiveSession {
    async fn connect() -> Self {
        let key = configured_openai_key().expect("Gyournal OPENAI_API_KEY must be configured");
        let url = format!("wss://api.openai.com/v1/realtime?model={REALTIME_MODEL}");
        let mut request = url.into_client_request().unwrap();
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {key}")).unwrap(),
        );
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(request))
            .await
            .expect("Realtime connection timed out")
            .expect("Realtime connection failed");
        send(
            &mut socket,
            json!({
                "type": "session.update",
                "session": {
                    "type": "realtime",
                    "model": REALTIME_MODEL,
                    "output_modalities": ["text"],
                    "instructions": REALTIME_INSTRUCTIONS,
                    "tool_choice": "none"
                }
            }),
        )
        .await;
        wait_for_type(&mut socket, "session.updated").await;
        Self {
            socket,
            history: Vec::new(),
        }
    }

    async fn append_text(&mut self, role: &str, content_type: &str, text: &str) {
        self.append_existing(message_item(role, content_type, text))
            .await;
    }

    async fn append_quick(&mut self, turn_id: &str, text: &str) {
        self.append_text(
            "assistant",
            "output_text",
            &format!("QUICK_ANSWER turn={turn_id}\n{text}"),
        )
        .await;
    }

    async fn append_user(&mut self, content: Vec<Value>) {
        self.append_existing(json!({
            "id": item_id("user"),
            "type": "message",
            "role": "user",
            "content": content
        }))
        .await;
    }

    async fn append_existing(&mut self, item: Value) {
        send(
            &mut self.socket,
            json!({
                "type": "conversation.item.create",
                "item": item.clone()
            }),
        )
        .await;
        self.history.push(item);
    }

    async fn create_response(&mut self, turn_id: &str) {
        self.create_response_with(turn_id, self.references()).await;
    }

    fn references(&self) -> Vec<Value> {
        self.history
            .iter()
            .filter_map(|item| {
                item.get("id")
                    .and_then(Value::as_str)
                    .map(|id| json!({ "type": "item_reference", "id": id }))
            })
            .collect()
    }

    async fn create_response_with(&mut self, turn_id: &str, input: Vec<Value>) {
        send(
            &mut self.socket,
            json!({
                "type": "response.create",
                "response": {
                    "conversation": "none",
                    "input": input,
                    "output_modalities": ["text"],
                    "metadata": { "client_turn_id": turn_id },
                    "instructions": REALTIME_INSTRUCTIONS,
                    "max_output_tokens": 350
                }
            }),
        )
        .await;
    }

    async fn ask_text(&mut self, turn_id: &str, text: &str) -> LiveResponse {
        self.ask(turn_id, vec![json!({ "type": "input_text", "text": text })])
            .await
    }

    async fn ask(&mut self, turn_id: &str, content: Vec<Value>) -> LiveResponse {
        let started = Instant::now();
        self.append_user(content).await;
        self.create_response(turn_id).await;
        collect_responses(&mut self.socket, 1, started)
            .await
            .remove(0)
    }
}

async fn collect_responses(
    socket: &mut Socket,
    expected: usize,
    started: Instant,
) -> Vec<LiveResponse> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut turns = HashMap::<String, Option<String>>::new();
        let mut texts = HashMap::<String, String>::new();
        let mut deltas = HashSet::<String>::new();
        let mut first_tokens = HashMap::<String, u128>::new();
        let mut completed = Vec::new();
        loop {
            let event = next_json(socket).await;
            match event.get("type").and_then(Value::as_str) {
                Some("response.created") => {
                    let response_id = event
                        .pointer("/response/id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let turn = event
                        .pointer("/response/metadata/client_turn_id")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    turns.insert(response_id, turn);
                }
                Some("response.output_text.delta") | Some("response.text.delta") => {
                    let response_id = event
                        .get("response_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    deltas.insert(response_id.to_string());
                    first_tokens
                        .entry(response_id.to_string())
                        .or_insert_with(|| started.elapsed().as_millis());
                    texts.entry(response_id.to_string()).or_default().push_str(
                        event
                            .get("delta")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    );
                }
                Some("response.done") => {
                    let response_id = event
                        .pointer("/response/id")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let mut text = texts.remove(response_id).unwrap_or_default();
                    if text.is_empty() {
                        text = response_output_text(&event);
                    }
                    completed.push(LiveResponse {
                        text,
                        turn_id: turns.remove(response_id).flatten(),
                        saw_delta: deltas.remove(response_id),
                        first_token_ms: first_tokens.remove(response_id).unwrap_or_default(),
                    });
                    if completed.len() == expected {
                        return completed;
                    }
                }
                Some("error") => panic!("Realtime API error: {event}"),
                _ => {}
            }
        }
    })
    .await
    .expect("Realtime response timed out")
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

async fn wait_for_type(socket: &mut Socket, expected: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = next_json(socket).await;
            if event.get("type").and_then(Value::as_str) == Some(expected) {
                return;
            }
            if event.get("type").and_then(Value::as_str) == Some("error") {
                panic!("Realtime setup error: {event}");
            }
        }
    })
    .await
    .expect("Realtime setup timed out");
}

async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn next_json(socket: &mut Socket) -> Value {
    loop {
        let message = socket
            .next()
            .await
            .expect("Realtime socket closed")
            .expect("Realtime receive failed");
        if let Message::Text(text) = message {
            if let Ok(value) = serde_json::from_str(&text) {
                return value;
            }
        }
    }
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
        .collect()
}

fn test_image_data_url() -> String {
    let image = ImageBuffer::from_fn(64, 64, |x, y| {
        if x < 32 && y < 32 {
            Rgb([255, 0, 0])
        } else {
            Rgb([0, 80, 220])
        }
    });
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(image)
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    )
}
