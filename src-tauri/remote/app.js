import {
  coalesceDelta,
  isScrollArmed,
  isTapGesture,
  momentumStep,
  pointerDistance,
  pointerScrollDelta,
  shouldDeferSend,
} from "./controller-gestures.mjs";

const ROLE_KEY = "codex-view.role";
const conversation = document.querySelector("#conversation");
const connection = document.querySelector("#connection");
const controls = document.querySelector("#controls");
const liveTranscript = document.querySelector("#live-transcript");
const displayRoot = document.querySelector("#display-root");
const controllerRoot = document.querySelector("#controller-root");
const controllerStatus = document.querySelector("#controller-status");
const pad = document.querySelector("#pad");
const controllerSend = document.querySelector("#controller-send");
const controllerControls = document.querySelector("#controller-controls");

let socket;
let reconnectTimer;
let reconnectAttempt = 0;
let lastSequence = 0;
let followOutput = true;
let lastSnapshot;
let wakeLock;
let applyingRemoteScroll = false;
let pendingDisplayDelta = 0;
let displayApplyFrame = 0;
let gestureId = 0;
let activePointer = null;
let pointerStartX = 0;
let pointerStartY = 0;
let pointerStartAt = 0;
let lastPointerY = 0;
let lastPointerAt = 0;
let scrollArmed = false;
let velocity = 0;
let pendingControllerDelta = 0;
let controllerSendFrame = 0;
let momentumFrame = 0;
let role = resolveRole();

applyRole(role);

function resolveRole() {
  const params = new URLSearchParams(location.search);
  if (params.get("mode") === "controller") return "controller";
  if (params.get("mode") === "display") return "display";
  try {
    const saved = window.localStorage.getItem(ROLE_KEY);
    if (saved === "controller" || saved === "display") return saved;
  } catch {
    /* Storage is optional. */
  }
  return "display";
}

function persistRole(nextRole) {
  try { window.localStorage.setItem(ROLE_KEY, nextRole); } catch { /* Persistence is optional. */ }
  const url = new URL(location.href);
  url.searchParams.set("mode", nextRole);
  location.assign(`${url.pathname}${url.search}`);
}

function applyRole(nextRole) {
  const controller = nextRole === "controller";
  document.body.classList.toggle("controller", controller);
  displayRoot.hidden = controller;
  controllerRoot.hidden = !controller;
  connection.classList.toggle("controller-visible", controller);
}

function isAtTrueBottom() {
  const naturalBottom = naturalBottomScrollTop();
  return Math.abs(conversation.scrollTop - naturalBottom) <= 2;
}

function naturalBottomScrollTop() {
  const readingTail = conversation.querySelector(".reading-tail");
  const tailHeight = readingTail?.offsetHeight || 0;
  return Math.max(0, conversation.scrollHeight - conversation.clientHeight - tailHeight);
}

function scrollToNaturalBottom(behavior = "auto") {
  conversation.scrollTo({ top: naturalBottomScrollTop(), behavior });
}

function vibrate(pattern = 12) {
  try { navigator.vibrate?.(pattern); } catch { /* Haptics are optional. */ }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);
}

function renderMarkdown(value) {
  const escaped = escapeHtml(value).replace(/\r\n/g, "\n");
  const blocks = [];
  const withoutBlocks = escaped.replace(/```(?:[^\n]*)\n?([\s\S]*?)(?:```|$)/g, (_, code) => {
    const index = blocks.push(`<pre><code>${code.replace(/^\n|\n$/g, "")}</code></pre>`) - 1;
    return `\n@@BLOCK_${index}@@\n`;
  });
  let html = withoutBlocks
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .split(/\n{2,}/)
    .map((section) => {
      const trimmed = section.trim();
      if (!trimmed) return "";
      if (/^@@BLOCK_\d+@@$/.test(trimmed) || /^<(?:h\d|pre|ul|ol)/.test(trimmed)) return trimmed;
      if (/^(?:<li>[\s\S]*<\/li>\s*)+$/.test(trimmed)) return `<ul>${trimmed}</ul>`;
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
  blocks.forEach((block, index) => { html = html.replace(`@@BLOCK_${index}@@`, block); });
  return html;
}

function messageMarkup(roleName, label, content, waiting) {
  return `<article class="message ${roleName}"><div class="role">${label}</div><div class="content ${waiting ? "waiting" : ""}">${waiting ? escapeHtml(content) : renderMarkdown(content)}</div></article>`;
}

function renderControls(snapshot) {
  const lifecycle = snapshot?.lifecycle || (snapshot?.started ? "active" : "idle");
  const isWebAppSession = snapshot?.mode === "webapp";
  controls.className = `controls ${lifecycle}`;
  if (lifecycle === "idle") {
    const models = Array.isArray(snapshot?.piModels) ? snapshot.piModels : [];
    const selectedKey = snapshot?.piSelection?.key;
    const options = models.map((model) => `<option value="${escapeHtml(model.key)}" ${model.key === selectedKey ? "selected" : ""}>${escapeHtml(model.label)}</option>`).join("");
    controls.hidden = false;
    controls.innerHTML = `<select id="pi-model" aria-label="Authoritative Pi model">${options}</select><button type="button" data-action="start_session" class="primary">Start Session</button><button type="button" data-role="controller">Controller</button>`;
    controls.classList.add("idle");
  } else if (lifecycle === "starting" && isWebAppSession) {
    controls.hidden = false;
    controls.innerHTML = `<button type="button" disabled>Starting…</button><button type="button" data-action="end_session" class="danger">End Session</button>`;
  } else if (lifecycle === "active" && isWebAppSession) {
    const failed = Array.isArray(snapshot.failedServices) ? snapshot.failedServices : [];
    const primary = failed.length
      ? `<button type="button" data-action="retry_failed" class="primary">Retry failed</button>`
      : snapshot.busy
        ? `<button type="button" data-action="stop_send" class="primary" ${snapshot.canSend ? "" : "disabled"}>Stop + Send</button>`
        : `<button type="button" data-action="send" class="primary" ${snapshot.canSend ? "" : "disabled"}>${snapshot.canSend ? "Send" : "Getting ready…"}</button>`;
    controls.hidden = false;
    controls.innerHTML = `<button type="button" data-action="screenshot">Screenshot</button>${primary}<button type="button" data-action="end_session" class="danger">End Session</button>`;
  } else if (lifecycle === "stopping" && isWebAppSession) {
    controls.hidden = false;
    controls.innerHTML = `<button type="button" disabled>Ending session…</button>`;
  } else {
    controls.hidden = true;
    controls.innerHTML = "";
  }
}

function renderController(snapshot) {
  const displays = Number(snapshot?.connectedDisplays) || 0;
  const controllers = Number(snapshot?.connectedControllers) || 0;
  const lifecycle = snapshot?.lifecycle || (snapshot?.started ? "active" : "idle");
  controllerStatus.textContent = socket?.readyState === WebSocket.OPEN
    ? `Connected · ${displays} display · ${controllers} controller`
    : "Mac disconnected";
  const canAct = lifecycle === "active" && snapshot?.mode === "webapp";
  controllerSend.disabled = !canAct || !snapshot?.canSend;
  controllerSend.dataset.action = snapshot?.busy ? "stop_send" : "send";
  controllerSend.textContent = snapshot?.busy ? "Stop + Send" : snapshot?.canSend ? "Send" : "Getting ready…";
}

function renderLiveTranscript(snapshot) {
  const current = snapshot?.started ? snapshot.liveTranscript : null;
  const text = String(current?.text || "").trim();
  liveTranscript.hidden = !text;
  liveTranscript.innerHTML = text
    ? `<span class="live-source">${escapeHtml(current.source)}</span><span class="live-text">${escapeHtml(text)}</span>`
    : "";
  requestAnimationFrame(updateBottomSpacing);
}

function updateBottomSpacing() {
  if (role === "controller") return;
  const controlsHeight = controls.hidden ? 0 : controls.getBoundingClientRect().height;
  liveTranscript.style.bottom = `${controlsHeight}px`;
  const transcriptHeight = liveTranscript.hidden ? 0 : liveTranscript.getBoundingClientRect().height;
  conversation.style.setProperty("--bottom-space", `${controlsHeight + transcriptHeight + 12}px`);
}

function render(snapshot) {
  lastSnapshot = snapshot;
  if (role === "controller") {
    renderController(snapshot);
    return;
  }
  const previousScrollTop = conversation.scrollTop;
  const shouldFollow = followOutput && isAtTrueBottom();
  renderControls(snapshot);
  renderLiveTranscript(snapshot);
  const messages = Array.isArray(snapshot?.messages)
    ? snapshot.messages.filter((message) => message.role === "assistant" && message.turnId)
    : [];
  if (!snapshot?.started || messages.length === 0) {
    const text = snapshot?.started ? "Listening for the first question…" : "Waiting for the session on your Mac…";
    let empty = conversation.querySelector(".empty");
    if (!empty || conversation.children.length !== 1) {
      conversation.replaceChildren();
      empty = document.createElement("div");
      empty.className = "empty";
      conversation.append(empty);
    }
    empty.textContent = text;
    return;
  }

  conversation.querySelector(".empty")?.remove();
  const activeTurnIds = new Set(messages.map((message) => message.turnId));
  conversation.querySelectorAll(".turn").forEach((turn) => {
    if (!activeTurnIds.has(turn.dataset.turn)) turn.remove();
  });
  for (const assistant of messages) {
    let turn = [...conversation.querySelectorAll(".turn")].find((candidate) => candidate.dataset.turn === assistant.turnId);
    if (!turn) {
      turn = document.createElement("section");
      turn.className = "turn";
      turn.dataset.turn = assistant.turnId;
      turn.innerHTML = `${messageMarkup("quick", "Quick", "Waiting for Quick…", true)}${messageMarkup("pi", "Pi", "Waiting for Pi…", true)}`;
      const tail = conversation.querySelector(".reading-tail");
      conversation.insertBefore(turn, tail);
    }
    const updateLane = (selector, value, waiting) => {
      const node = turn.querySelector(`${selector} .content`);
      if (!node) return;
      const nextValue = String(value || "");
      if (node.dataset.source !== nextValue) {
        node.innerHTML = waiting ? escapeHtml(nextValue) : renderMarkdown(nextValue);
        node.dataset.source = nextValue;
      }
      node.classList.toggle("waiting", waiting);
    };
    updateLane(".quick", assistant.quickContent || assistant.quickError || "Waiting for Quick…", !assistant.quickContent && !assistant.quickError);
    updateLane(".pi", assistant.content || assistant.piError || "Waiting for Pi…", !assistant.content && !assistant.piError);
  }
  if (!conversation.querySelector(".reading-tail")) {
    const tail = document.createElement("div");
    tail.className = "reading-tail";
    tail.setAttribute("aria-hidden", "true");
    conversation.append(tail);
  }
  followOutput = shouldFollow;
  requestAnimationFrame(() => {
    if (shouldFollow) scrollToNaturalBottom();
    else conversation.scrollTop = previousScrollTop;
  });
}

function sendJson(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    connection.textContent = "Mac disconnected";
    connection.classList.remove("connected");
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function sendControl(action) {
  const command = { type: "control.command", action };
  if (action === "start_session" || action === "select_model") {
    const selectedKey = controls.querySelector("#pi-model")?.value;
    const selection = lastSnapshot?.piModels?.find((model) => model.key === selectedKey);
    if (selection) {
      command.provider = selection.provider;
      command.model = selection.model;
      command.modelKey = selection.key;
    }
  }
  if (!sendJson(command)) return;
  const button = document.querySelector(`[data-action="${action}"]`);
  if (!button) return;
  if (action === "start_session" || action === "end_session" || action === "retry_failed") {
    button.disabled = true;
    button.textContent = action === "start_session" ? "Starting…" : action === "end_session" ? "Ending…" : "Retrying…";
  }
  button.classList.add("sent");
  vibrate();
  window.setTimeout(() => button.classList.remove("sent"), 180);
}

function handleScroll(action) {
  const precise = 28;
  const page = Math.max(precise, Math.round(conversation.clientHeight * 0.86));
  if (action === "step_up") {
    followOutput = false;
    conversation.scrollTop -= precise;
  } else if (action === "step_down") {
    conversation.scrollTop += precise;
  } else if (action === "page_up") {
    followOutput = false;
    conversation.scrollTop -= page;
  } else if (action === "page_down") {
    conversation.scrollTop += page;
  } else if (action === "jump_bottom") {
    followOutput = true;
    scrollToNaturalBottom("smooth");
  } else if (action === "toggle_follow") {
    followOutput = !followOutput;
    if (followOutput) scrollToNaturalBottom("smooth");
  }
}

function queueDisplayDelta(deltaY) {
  followOutput = false;
  pendingDisplayDelta += deltaY;
  if (!displayApplyFrame) displayApplyFrame = requestAnimationFrame(applyDisplayDelta);
}

function applyDisplayDelta() {
  displayApplyFrame = 0;
  const delta = pendingDisplayDelta;
  pendingDisplayDelta = 0;
  if (!delta) return;
  applyingRemoteScroll = true;
  conversation.scrollTop += delta;
  if (isAtTrueBottom()) followOutput = true;
  requestAnimationFrame(() => { applyingRemoteScroll = false; });
}

function jumpLatest() {
  followOutput = true;
  pendingDisplayDelta = 0;
  scrollToNaturalBottom("smooth");
}

function stopMomentum() {
  if (momentumFrame) cancelAnimationFrame(momentumFrame);
  momentumFrame = 0;
  velocity = 0;
}

function sendControllerScroll(deltaY, ended = false) {
  if (!deltaY && !ended) return;
  const payload = ended
    ? { type: "controller.scroll_end", gestureId }
    : { type: "controller.scroll", deltaY, gestureId };
  if (shouldDeferSend(socket?.bufferedAmount) && !ended) {
    pendingControllerDelta = coalesceDelta(pendingControllerDelta, deltaY);
    return;
  }
  sendJson(payload);
}

function flushControllerDelta() {
  controllerSendFrame = 0;
  if (!pendingControllerDelta) return;
  const delta = pendingControllerDelta;
  pendingControllerDelta = 0;
  sendControllerScroll(delta);
}

function queueControllerDelta(deltaY) {
  pendingControllerDelta = coalesceDelta(pendingControllerDelta, deltaY);
  if (!controllerSendFrame) controllerSendFrame = requestAnimationFrame(flushControllerDelta);
}

function runMomentum() {
  velocity = momentumStep(velocity);
  if (!velocity) {
    momentumFrame = 0;
    sendControllerScroll(0, true);
    return;
  }
  sendControllerScroll(velocity);
  momentumFrame = requestAnimationFrame(runMomentum);
}

function triggerControllerSend() {
  if (controllerSend.disabled) return;
  sendControl(controllerSend.dataset.action || "send");
}

function onControllerPointerDown(event) {
  if (event.target.closest("button")) return;
  stopMomentum();
  controllerRoot.setPointerCapture(event.pointerId);
  activePointer = event.pointerId;
  pointerStartX = event.clientX;
  pointerStartY = event.clientY;
  pointerStartAt = event.timeStamp;
  lastPointerY = event.clientY;
  lastPointerAt = event.timeStamp;
  scrollArmed = false;
  velocity = 0;
  pad.classList.add("active");
}

function onControllerPointerMove(event) {
  if (activePointer !== event.pointerId) return;
  const distance = pointerDistance(pointerStartX, pointerStartY, event.clientX, event.clientY);
  if (!scrollArmed && isScrollArmed(distance)) {
    scrollArmed = true;
    gestureId += 1;
  }
  if (!scrollArmed) return;
  const delta = pointerScrollDelta(lastPointerY, event.clientY);
  const elapsed = Math.max(1, event.timeStamp - lastPointerAt);
  velocity = delta * (16 / elapsed);
  lastPointerY = event.clientY;
  lastPointerAt = event.timeStamp;
  if (delta) queueControllerDelta(delta);
}

function onControllerPointerUp(event) {
  if (activePointer !== event.pointerId) return;
  controllerRoot.releasePointerCapture(event.pointerId);
  activePointer = null;
  pad.classList.remove("active");
  const distance = pointerDistance(pointerStartX, pointerStartY, event.clientX, event.clientY);
  const durationMs = event.timeStamp - pointerStartAt;
  if (!scrollArmed && isTapGesture({ distance, durationMs })) {
    pendingControllerDelta = 0;
    triggerControllerSend();
    return;
  }
  if (!scrollArmed) {
    pendingControllerDelta = 0;
    return;
  }
  flushControllerDelta();
  if (Math.abs(velocity) > 1.2) runMomentum();
  else sendControllerScroll(0, true);
}

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  connection.textContent = reconnectAttempt ? "Reconnecting to Mac…" : "Connecting to Mac…";
  connection.classList.remove("connected");
  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    lastSequence = 0;
    connection.textContent = "Connected";
    connection.classList.add("connected");
    sendJson({ type: "client.hello", role });
  });
  socket.addEventListener("message", ({ data }) => {
    try {
      const event = JSON.parse(data);
      if (Number(event.sequence) <= lastSequence) return;
      lastSequence = Number(event.sequence);
      if (event.type === "session.snapshot") render(event.payload);
      if (role === "display" && event.type === "scroll.command") handleScroll(event.payload?.action);
      if (role === "display" && event.type === "controller.scroll") queueDisplayDelta(Number(event.payload?.deltaY) || 0);
      if (role === "display" && event.type === "controller.jump_latest") jumpLatest();
    } catch {
      connection.textContent = "Invalid update from Mac";
      connection.classList.remove("connected");
    }
  });
  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", () => socket.close());
}

function scheduleReconnect() {
  connection.textContent = "Mac disconnected · retrying…";
  connection.classList.remove("connected");
  if (role === "controller") controllerStatus.textContent = "Mac disconnected · retrying…";
  const delay = Math.min(5000, 350 * 2 ** reconnectAttempt++);
  reconnectTimer = setTimeout(connect, delay);
}

async function keepScreenAwake() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch { /* Device settings remain authoritative. */ }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void keepScreenAwake();
    if (!socket || socket.readyState > WebSocket.OPEN) connect();
    if (lastSnapshot) render(lastSnapshot);
  }
});

conversation.addEventListener("scroll", () => {
  if (applyingRemoteScroll) return;
  followOutput = isAtTrueBottom();
}, { passive: true });

controls.addEventListener("click", (event) => {
  const roleButton = event.target.closest("[data-role]");
  if (roleButton) {
    persistRole(roleButton.dataset.role);
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  sendControl(button.dataset.action);
});

controls.addEventListener("change", (event) => {
  if (event.target?.id === "pi-model") sendControl("select_model");
});

controllerControls.addEventListener("click", (event) => {
  const roleButton = event.target.closest("[data-role]");
  if (roleButton) {
    persistRole(roleButton.dataset.role);
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  if (button.dataset.action === "jump_latest") {
    sendJson({ type: "controller.jump_latest" });
    button.classList.add("sent");
    vibrate();
    window.setTimeout(() => button.classList.remove("sent"), 180);
    return;
  }
  sendControl(button.dataset.action);
});

controllerRoot.addEventListener("pointerdown", onControllerPointerDown);
controllerRoot.addEventListener("pointermove", onControllerPointerMove);
controllerRoot.addEventListener("pointerup", onControllerPointerUp);
controllerRoot.addEventListener("pointercancel", onControllerPointerUp);
controllerRoot.addEventListener("lostpointercapture", () => {
  activePointer = null;
  scrollArmed = false;
  pad.classList.remove("active");
});

document.addEventListener("touchmove", (event) => {
  if (role === "controller" && !event.target.closest("button")) event.preventDefault();
}, { passive: false });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
window.addEventListener("resize", updateBottomSpacing);
void keepScreenAwake();
connect();
