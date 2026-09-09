import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import QRCode from "qrcode";
import {
  appendSessionEvent,
  checkpointSession,
  createSessionRecord,
  finishSessionRecord,
  markUnfinishedSessionsInterrupted,
  type PersistedLaneStatus,
  type PersistedSessionStatus,
  type SessionTurnRecord,
} from "./lib/database/overlay-session-history";
import "./global.css";

const root = document.getElementById("root")!;
let workspace = (() => {
  try { return window.localStorage.getItem("codex-overlay.workspace") ?? ""; }
  catch { return ""; }
})();
type SessionMode = "overlay" | "webapp";
type PiThinkingLevel = "low" | "medium" | "high" | "max";
type PiModelChoice = {
  key: string;
  provider: "openai-codex" | "xai" | "cursor" | "openrouter";
  model: string;
  thinkingLevel: PiThinkingLevel;
  label: string;
  shortLabel: string;
  nitro?: boolean;
};
const PI_MODEL_CHOICES: PiModelChoice[] = [
  { key: "openai-codex/gpt-5.6-terra", provider: "openai-codex", model: "gpt-5.6-terra", thinkingLevel: "low", label: "GPT-5.6 Terra · ChatGPT OAuth", shortLabel: "Terra" },
  { key: "cursor/gpt-5.6-terra@272k:fast", provider: "cursor", model: "gpt-5.6-terra@272k:fast", thinkingLevel: "low", label: "GPT-5.6 Terra · Cursor Fast", shortLabel: "Terra Fast" },
  { key: "openrouter/openai/gpt-5.6-terra@low-nitro", provider: "openrouter", model: "openai/gpt-5.6-terra", thinkingLevel: "low", nitro: true, label: "GPT-5.6 Terra · OpenRouter Nitro", shortLabel: "Terra Nitro" },
  { key: "cursor/grok-4.6:fast@medium", provider: "cursor", model: "grok-4.6:fast", thinkingLevel: "medium", label: "Grok 4.6 · Cursor Med Fast", shortLabel: "Grok Med" },
  { key: "openai-codex/gpt-5.6-sol", provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "low", label: "GPT-5.6 Sol · Low · Fast", shortLabel: "Sol 5.6" },
  { key: "xai/grok-4.5", provider: "xai", model: "grok-4.5", thinkingLevel: "low", label: "Grok 4.5 · xAI subscription", shortLabel: "Grok 4.5" },
  { key: "xai/grok-4.6", provider: "xai", model: "grok-4.6", thinkingLevel: "low", label: "Grok 4.6 · xAI subscription", shortLabel: "Grok 4.6" },
  { key: "openrouter/z-ai/glm-5.3-flash@low", provider: "openrouter", model: "z-ai/glm-5.3-flash", thinkingLevel: "low", label: "GLM 5.3 Flash · OpenRouter Low", shortLabel: "GLM Low" },
  { key: "openrouter/z-ai/glm-5.3-flash@high", provider: "openrouter", model: "z-ai/glm-5.3-flash", thinkingLevel: "high", label: "GLM 5.3 Flash · OpenRouter High", shortLabel: "GLM High" },
  { key: "openrouter/z-ai/glm-5.3-flash@max", provider: "openrouter", model: "z-ai/glm-5.3-flash", thinkingLevel: "max", label: "GLM 5.3 Flash · OpenRouter Max", shortLabel: "GLM Max" },
];
const DEFAULT_PI_MODEL_KEY = PI_MODEL_CHOICES[0].key;

function loadPiModelKey() {
  try {
    const saved = window.localStorage.getItem("codex-overlay.pi-model");
    if (PI_MODEL_CHOICES.some((choice) => choice.key === saved)) return saved!;
  } catch { /* The default remains available when storage is unavailable. */ }
  return DEFAULT_PI_MODEL_KEY;
}

let selectedPiModelKey = loadPiModelKey();
type RemoteBridgeInfo = {
  url: string;
  websocketUrl: string;
  port: number;
  connectedClients: number;
};
let sessionMode: SessionMode = "overlay";
let remoteBridge: RemoteBridgeInfo | null = null;
let remoteQrCode = "";
let remoteClients = 0;
let remotePublishTimer: number | undefined;
let remotePublishPending = false;
let remotePublishInFlight = false;
let remoteLastPublishedAt = 0;
const REMOTE_PUBLISH_INTERVAL_MS = 50;
const quickWatchdogs = new Map<string, number>();
let started = false;
let sessionStarting = false;
let active = false;
let inputReady = false;
let busy = false;
let piStopPromise: Promise<void> | undefined;
let turnGeneration = 0;
let typed = "";
type PendingScreenshot = { path: string };
let screenshots: PendingScreenshot[] = [];
let screenshotCaptureInFlight = false;
let screenshotCaptureQueue = 0;
let error = "";
let sessionId = "";
let audioStatus = "Audio starting";
let echoStatus = "AEC starting";
let speakerLevel = 0;
let speakerRecoveryTimer: number | undefined;
type AudioDevice = { id: string; name: string; is_default: boolean };
type MicrophoneDevice = { name: string; is_default: boolean };
let microphones: MicrophoneDevice[] = [];
let outputs: AudioDevice[] = [];
let microphoneName = "";
let outputId = "";
let activeClientTurnId = "";
let clientTurnCounter = 0;
let piActivity = "Pi is thinking...";
type ContextInfo = { version: string; hash: string; file_count: number; byte_count: number };
type PreparationStatus = { phase: "preparing" | "ready" | "error"; message: string; context?: ContextInfo };
let realtimeContextStatus = "Quick context pending";
let piPreparing = false;
let piContextStatus = "Pi context pending";
type RecoveryState = "starting" | "ready" | "retrying" | "failed" | "closed";
let quickState: RecoveryState = "starting";
let piState: RecoveryState = "starting";
let microphoneState: RecoveryState = "starting";
let speakerState: RecoveryState = "starting";
let sessionEpoch = 0;
let closingSession = false;
type TranscriptSource = "You" | "Speaker";
let liveTranscript: { source: TranscriptSource; text: string } | null = null;
let historySessionId = "";
let historySessionStartedAt = 0;
let historyEventSequence = 0;
let historyCheckpointTimer: number | undefined;
let historyWriteChain: Promise<void> = Promise.resolve();
let historyPersistenceError = "";
const historyInitialization = markUnfinishedSessionsInterrupted().catch((cause) => {
  historyPersistenceError = String(cause);
  console.error("Failed to initialize session history", cause);
});
type TranscriptWord = { text: string; start: number; end: number; utterance: number; order: number; sent: boolean };
type GrokTranscript = {
  source: TranscriptSource;
  text: string;
  words: Array<{ text?: string; word?: string; start?: number; end?: number }>;
  is_final: boolean;
  speech_final: boolean;
  start: number;
  duration: number;
};
const finalizedWords: Record<TranscriptSource, TranscriptWord[]> = { You: [], Speaker: [] };
const activeWords: Record<TranscriptSource, TranscriptWord[]> = { You: [], Speaker: [] };
const finalizedThrough: Record<TranscriptSource, number> = { You: -1, Speaker: -1 };
const sentAudioThrough: Record<TranscriptSource, number> = { You: -1, Speaker: -1 };
const utteranceGeneration: Record<TranscriptSource, number> = { You: 0, Speaker: 0 };
const utteranceOrder: Record<TranscriptSource, number> = { You: 0, Speaker: 0 };
let nextUtteranceOrder = 0;
type Message = {
  role: "user" | "assistant";
  content: string;
  turnId?: string;
  startedAt?: number;
  itemId?: string;
  firstTokenMs?: number;
  quickContent?: string;
  quickFirstTokenMs?: number;
  quickDone?: boolean;
  quickError?: string;
  quickRetries?: number;
  quickRetrying?: boolean;
  piError?: string;
  piRetries?: number;
  piRetrying?: boolean;
  imagePaths?: string[];
  piPrompt?: string;
  verifiedSynced?: boolean;
  submittedAtEpoch?: number;
  completedAtEpoch?: number;
  manualText?: string;
  transcriptLines?: string[];
  piDone?: boolean;
  piStopped?: boolean;
};
const messages: Message[] = [];

function queueHistoryWrite(operation: () => Promise<void>) {
  const write = historyWriteChain.then(operation).then(() => {
    historyPersistenceError = "";
  });
  historyWriteChain = write.catch((cause) => {
    historyPersistenceError = String(cause);
    console.error("Session history write failed", cause);
  });
  return write;
}

function historyLaneStatus(
  content: string | undefined,
  done: boolean | undefined,
  stopped: boolean | undefined,
  laneError: string | undefined,
): PersistedLaneStatus {
  if (laneError) return "failed";
  if (stopped) return "stopped";
  if (done) return "completed";
  if (content) return "streaming";
  return "pending";
}

function persistedTurns(): SessionTurnRecord[] {
  if (!historySessionId) return [];
  const users = messages.filter((message) => message.role === "user" && message.turnId);
  return users.map((user, index) => {
    const assistant = assistantForTurn(user.turnId!);
    const quickStatus = historyLaneStatus(
      assistant?.quickContent,
      assistant?.quickDone,
      false,
      assistant?.quickError,
    );
    const piStatus = historyLaneStatus(
      assistant?.content,
      assistant?.piDone,
      assistant?.piStopped,
      assistant?.piError,
    );
    return {
      id: `${historySessionId}:${user.turnId}`,
      sessionId: historySessionId,
      sequence: index + 1,
      submittedAt: user.submittedAtEpoch ?? historySessionStartedAt,
      updatedAt: Date.now(),
      completedAt: assistant?.completedAtEpoch,
      promptText: user.content,
      manualText: user.manualText,
      transcriptLines: user.transcriptLines ?? [],
      screenshotPaths: user.imagePaths ?? [],
      quickAnswer: assistant?.quickContent ?? "",
      quickStatus,
      quickError: assistant?.quickError,
      piAnswer: visiblePiContent(assistant?.content ?? ""),
      piStatus,
      piError: assistant?.piError,
    };
  });
}

function persistedSnapshot() {
  return {
    schemaVersion: 1,
    savedAt: Date.now(),
    session: {
      id: historySessionId,
      piSessionId: sessionId || null,
      startedAt: historySessionStartedAt,
      mode: sessionMode,
      workspace,
      piSelection: selectedPiChoice(),
      lifecycle: closingSession ? "stopping" : sessionStarting ? "starting" : started ? "active" : "ended",
      busy,
      activeKeyboardCapture: active,
      serviceStates: {
        quick: quickState,
        pi: piState,
        microphone: microphoneState,
        speaker: speakerState,
      },
      error: error || null,
      persistenceError: historyPersistenceError || null,
    },
    transcript: {
      finalizedWords,
      activeWords,
      pendingLines: pendingTranscriptLines(),
      latest: liveTranscript,
    },
    turns: persistedTurns(),
    draft: {
      text: typed,
      screenshotPaths: screenshots.map((image) => image.path),
    },
  };
}

function currentHistoryStatus(): PersistedSessionStatus {
  return started ? "active" : "starting";
}

function scheduleHistoryCheckpoint() {
  if (!historySessionId || historyCheckpointTimer !== undefined) return;
  historyCheckpointTimer = window.setTimeout(() => {
    historyCheckpointTimer = undefined;
    const id = historySessionId;
    if (!id) return;
    const snapshot = persistedSnapshot();
    const turns = persistedTurns();
    const status = currentHistoryStatus();
    const piSessionId = sessionId;
    const lastError = error;
    void queueHistoryWrite(() => checkpointSession(id, status, snapshot, turns, {
      piSessionId,
      lastError,
    }));
  }, 250);
}

async function flushHistoryCheckpoint(status: PersistedSessionStatus = currentHistoryStatus()) {
  if (historyCheckpointTimer !== undefined) {
    window.clearTimeout(historyCheckpointTimer);
    historyCheckpointTimer = undefined;
  }
  const id = historySessionId;
  if (!id) return;
  const snapshot = persistedSnapshot();
  const turns = persistedTurns();
  const piSessionId = sessionId;
  const lastError = error;
  await queueHistoryWrite(() => checkpointSession(id, status, snapshot, turns, {
    piSessionId,
    lastError,
  }));
}

function recordHistoryEvent(
  eventType: string,
  payload: unknown = {},
  details: { source?: string; turnId?: string } = {},
) {
  const sessionIdForEvent = historySessionId;
  if (!sessionIdForEvent) return;
  const sequence = ++historyEventSequence;
  const createdAt = Date.now();
  void queueHistoryWrite(() => appendSessionEvent({
    sessionId: sessionIdForEvent,
    sequence,
    eventType,
    source: details.source,
    turnId: details.turnId,
    payload,
    createdAt,
  }));
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && historySessionId) {
    void flushHistoryCheckpoint();
  }
});

function remoteSnapshot() {
  const lifecycle = closingSession
    ? "stopping"
    : sessionStarting
      ? "starting"
      : started
        ? "active"
        : "idle";
  return {
    started,
    lifecycle,
    mode: started || sessionStarting ? sessionMode : null,
    busy,
    canSend: allServicesReady() && !sessionStarting && !closingSession,
    failedServices: failedServices(),
    serviceStates: {
      quick: quickState,
      pi: piState,
      microphone: microphoneState,
      speaker: speakerState,
    },
    diagnosticStatus: {
      audio: audioStatus,
      error,
      speakerLevel,
    },
    liveTranscript,
    piSelection: selectedPiChoice(),
    piModels: PI_MODEL_CHOICES,
    sessionId,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      turnId: message.turnId,
      hasScreenshot: Boolean(message.imagePaths?.length),
      quickContent: message.quickContent,
      quickDone: message.quickDone,
      quickError: message.quickError,
      piError: message.piError,
    })),
  };
}

function scheduleRemoteSnapshot(immediate = false) {
  if (!remoteBridge) return;
  remotePublishPending = true;
  if (remotePublishTimer !== undefined || remotePublishInFlight) return;
  const elapsed = performance.now() - remoteLastPublishedAt;
  const delay = immediate ? 0 : Math.max(0, REMOTE_PUBLISH_INTERVAL_MS - elapsed);
  remotePublishTimer = window.setTimeout(() => void flushRemoteSnapshot(), delay);
}

async function flushRemoteSnapshot() {
  remotePublishTimer = undefined;
  if (!remoteBridge || !remotePublishPending) return;
  remotePublishPending = false;
  remotePublishInFlight = true;
  remoteLastPublishedAt = performance.now();
  const snapshot = remoteSnapshot();
  try {
    await invoke("publish_remote_snapshot", { snapshot });
  } catch {
    // The latest state will be retried by the next render or reconnect snapshot.
  } finally {
    remotePublishInFlight = false;
    if (remotePublishPending) scheduleRemoteSnapshot();
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function clearQuickWatchdog(turnId: string) {
  const timer = quickWatchdogs.get(turnId);
  if (timer !== undefined) window.clearTimeout(timer);
  quickWatchdogs.delete(turnId);
}

function armQuickWatchdog(turnId: string, timeoutMs: number, phase: "first token" | "stream") {
  clearQuickWatchdog(turnId);
  const timer = window.setTimeout(async () => {
    quickWatchdogs.delete(turnId);
    const assistant = assistantForTurn(turnId);
    if (!assistant || assistant.quickDone || closingSession || !started) return;
    assistant.quickError = `Quick stalled while waiting for ${phase}`;
    quickState = "failed";
    render();
    await invoke("close_realtime_session").catch(() => {});
    const recovered = await recoverRealtime(true);
    if (recovered) await retryQuickTurn(turnId, true);
  }, timeoutMs);
  quickWatchdogs.set(turnId, timer);
}

function scheduleSpeakerRecovery(delay = 750) {
  if (speakerRecoveryTimer !== undefined || !started || closingSession) return;
  speakerRecoveryTimer = window.setTimeout(() => {
    speakerRecoveryTimer = undefined;
    void retrySpeaker(true);
  }, delay);
}

function recoveryLabel(state: RecoveryState) {
  return state === "ready" ? "Ready" : state === "retrying" ? "Retrying" : state === "failed" ? "Failed" : state === "closed" ? "Closed" : "Starting";
}

function selectedPiChoice() {
  return PI_MODEL_CHOICES.find((choice) => choice.key === selectedPiModelKey) ?? PI_MODEL_CHOICES[0];
}

function selectPiModelByKey(key: string) {
  const choice = PI_MODEL_CHOICES.find((candidate) => candidate.key === key);
  if (!choice) return false;
  selectedPiModelKey = choice.key;
  try { window.localStorage.setItem("codex-overlay.pi-model", choice.key); } catch { /* Persistence is optional. */ }
  return true;
}

function selectPiModel(provider: string, model: string) {
  const matches = PI_MODEL_CHOICES.filter((candidate) => candidate.provider === provider && candidate.model === model);
  if (matches.length !== 1) return false;
  return selectPiModelByKey(matches[0].key);
}

function failedServices() {
  return [
    ["Quick", quickState],
    ["Pi", piState],
    ["Microphone", microphoneState],
    ["Speaker", speakerState],
  ].filter(([, state]) => state === "failed").map(([name]) => name);
}

function allServicesReady() {
  return quickState === "ready"
    && piState === "ready"
    && microphoneState === "ready"
    && speakerState === "ready";
}

function normalizeTranscript(text: string) {
  return text.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isLikelyEcho(left: string, right: string) {
  const leftWords = left.split(" ").filter(Boolean);
  const rightWords = right.split(" ").filter(Boolean);
  if (Math.min(leftWords.length, rightWords.length) < 3) return false;
  if (left === right) return true;
  if ((left.includes(right) || right.includes(left)) && Math.min(left.length, right.length) >= 12) return true;
  const [shorter, longer] = leftWords.length <= rightWords.length
    ? [leftWords, rightWords]
    : [rightWords, leftWords];
  const longerWords = new Set(longer);
  const wordCoverage = shorter.filter((word) => longerWords.has(word)).length / shorter.length;
  const bigrams = (words: string[]) => words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`);
  const shorterBigrams = bigrams(shorter);
  const longerBigrams = new Set(bigrams(longer));
  const bigramCoverage = shorterBigrams.length
    ? shorterBigrams.filter((bigram) => longerBigrams.has(bigram)).length / shorterBigrams.length
    : 0;
  return wordCoverage >= 0.75 || bigramCoverage >= 0.6;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]!);
}

function visiblePiContent(value: string) {
  return value.trim();
}

function assistantForTurn(turnId: string) {
  return messages.find((message) => message.role === "assistant" && message.turnId === turnId);
}

function syncPiAnswer(message: Message, rawContent: string) {
  message.content = rawContent;
  const answer = visiblePiContent(rawContent);
  const shouldSyncAnswer = Boolean(answer && message.turnId && !message.verifiedSynced);
  if (shouldSyncAnswer) message.verifiedSynced = true;
  if (!shouldSyncAnswer) return;
  void (async () => {
    try {
      await invoke("append_realtime_verified_answer", {
        turnId: message.turnId!,
        answer,
      });
    } catch (cause) {
      message.verifiedSynced = false;
      error = `Realtime sync: ${String(cause)}`;
      render();
    }
  })();
}

function pendingTranscriptLines() {
  type Group = { source: TranscriptSource; order: number; words: TranscriptWord[] };
  const allGrouped = new Map<string, Group>();
  const pendingGrouped = new Map<string, Group>();
  for (const source of ["You", "Speaker"] as TranscriptSource[]) {
    for (const word of [...finalizedWords[source], ...activeWords[source]]) {
      const key = `${source}:${word.order}`;
      const allGroup = allGrouped.get(key) ?? { source, order: word.order, words: [] };
      allGroup.words.push(word);
      allGrouped.set(key, allGroup);
      if (!word.sent) {
        const pendingGroup = pendingGrouped.get(key) ?? { source, order: word.order, words: [] };
        pendingGroup.words.push(word);
        pendingGrouped.set(key, pendingGroup);
      }
    }
  }
  const toLines = (groups: Iterable<Group>) => [...groups].map((group) => ({
    source: group.source,
    order: group.order,
    text: group.words
      .sort((left, right) => left.start - right.start || left.end - right.end)
      .map((word) => word.text)
      .join(" ")
      .trim(),
  })).filter((line) => line.text).sort((left, right) => left.order - right.order);
  const pendingLines = toLines(pendingGrouped.values());
  const lines = pendingLines.reduce<typeof pendingLines>((staged, line) => {
    const previous = staged.at(-1);
    if (previous
      && previous.source === line.source
      && line.order === previous.order + 1
      && isLikelyEcho(normalizeTranscript(previous.text), normalizeTranscript(line.text))) {
      staged[staged.length - 1] = line;
    } else {
      staged.push(line);
    }
    return staged;
  }, []);
  const speakerReference = toLines(allGrouped.values())
    .filter((line) => line.source === "Speaker");
  return lines.filter((line) => {
    if (line.source !== "You") return true;
    return !speakerReference.some((candidate) => Math.abs(candidate.order - line.order) <= 4
      && isLikelyEcho(normalizeTranscript(line.text), normalizeTranscript(candidate.text)));
  }).map(({ source, text }) => `[${source} · live] ${text}`);
}

function wordsOverlap(left: TranscriptWord, right: TranscriptWord) {
  const overlap = Math.min(left.end, right.end) - Math.max(left.start, right.start);
  const shorterDuration = Math.max(0.01, Math.min(left.end - left.start, right.end - right.start));
  return Math.abs(left.start - right.start) < 0.05
    || (overlap > 0 && overlap / shorterDuration >= 0.6);
}

function reconcileActiveWords(previous: TranscriptWord[], incoming: TranscriptWord[]) {
  if (!previous.length) return incoming;
  if (!incoming.length) return previous;
  const overlapsPrevious = incoming.some((word) => previous.some((prior) => wordsOverlap(prior, word)));
  if (overlapsPrevious) {
    return incoming.map((word) => ({
      ...word,
      sent: word.sent || previous.some((prior) => prior.sent && wordsOverlap(prior, word)),
    }));
  }
  const combined = [...previous];
  for (const word of incoming) {
    if (!combined.some((prior) => prior.text === word.text && Math.abs(prior.start - word.start) < 0.03)) {
      combined.push(word);
    }
  }
  return combined;
}

function commitFinalizedWords(source: TranscriptSource, incoming: TranscriptWord[]) {
  for (const word of incoming) {
    const index = finalizedWords[source].findIndex((prior) => prior.utterance === word.utterance
      && wordsOverlap(prior, word));
    if (index < 0) {
      finalizedWords[source].push(word);
    } else if (!finalizedWords[source][index].sent) {
      finalizedWords[source][index] = word;
    }
  }
}

function applyTranscriptUpdate(update: GrokTranscript) {
  const source = update.source;
  const utterance = utteranceGeneration[source];
  if (!utteranceOrder[source]) utteranceOrder[source] = ++nextUtteranceOrder;
  const order = utteranceOrder[source];
  const words = update.words.map((word) => ({
    text: String(word.text ?? word.word ?? "").trim(),
    start: Number(word.start ?? update.start),
    end: Number(word.end ?? (update.start + update.duration)),
  })).filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end));
  const fallbackTokens = update.text.trim().split(/\s+/).filter(Boolean);
  const fallbackDuration = Math.max(update.duration, fallbackTokens.length * 0.01);
  const timedText = normalizeTranscript(words.map((word) => word.text).join(" "));
  const fullText = normalizeTranscript(update.text);
  const timedWordsAreComplete = Boolean(words.length && timedText === fullText);
  const incoming = timedWordsAreComplete ? words : fallbackTokens.map((text, index) => ({
    text,
    start: update.start + fallbackDuration * index / fallbackTokens.length,
    end: update.start + fallbackDuration * (index + 1) / fallbackTokens.length,
  }));
  const boundary = finalizedThrough[source];
  const unfinalized = boundary < 0
    ? incoming
    : incoming.filter((word) => word.start >= boundary - 0.03);
  const tracked = unfinalized.map((word) => ({
    ...word,
    utterance,
    order,
    sent: sentAudioThrough[source] >= 0 &&
      word.end <= sentAudioThrough[source] + 0.01,
  }));
  if (update.is_final) {
    const reconciled = reconcileActiveWords(activeWords[source], tracked);
    commitFinalizedWords(source, reconciled);
    finalizedWords[source].sort((left, right) => left.order - right.order || left.start - right.start || left.end - right.end);
    activeWords[source] = [];
    for (const word of incoming) finalizedThrough[source] = Math.max(finalizedThrough[source], word.end);
    if (update.speech_final) {
      finalizedThrough[source] = -1;
      sentAudioThrough[source] = -1;
      utteranceGeneration[source] += 1;
      utteranceOrder[source] = 0;
    }
  } else {
    activeWords[source] = reconcileActiveWords(activeWords[source], tracked);
  }
}

function render() {
  scheduleRemoteSnapshot();
  scheduleHistoryCheckpoint();
  const pendingTranscript = pendingTranscriptLines();
  const currentContent = document.querySelector<HTMLElement>(".content");
  const previousContentScrollTop = currentContent?.scrollTop ?? 0;
  const contentWasAtBottom = !currentContent
    || currentContent.scrollHeight - currentContent.scrollTop - currentContent.clientHeight <= 2;
  const currentPrompt = document.querySelector<HTMLTextAreaElement>("#prompt");
  const promptHadFocus = document.activeElement === currentPrompt;
  const previousSelectionStart = currentPrompt?.selectionStart ?? typed.length;
  const previousSelectionEnd = currentPrompt?.selectionEnd ?? previousSelectionStart;
  const previousPromptScrollTop = currentPrompt?.scrollTop ?? 0;
  const markup = `
    <main class="shell">
      <header class="topbar" data-tauri-drag-region>
        <span class="brand" data-tauri-drag-region>Codex Overlay</span>
        <span class="status ${active && inputReady ? "live" : ""}" data-tauri-drag-region>
          ${active ? (inputReady ? "Keyboard capture on" : "Waiting for Input Monitoring") : started ? "Audio live · Shift + tilde for keyboard" : "Session setup"}
        </span>
        <span class="spacer" data-tauri-drag-region></span>
        ${started ? `<span class="readiness ${quickState}" title="${escapeHtml(realtimeContextStatus)}" data-tauri-drag-region>Quick ${recoveryLabel(quickState).toLowerCase()}</span>` : ""}
        ${started ? `<span class="readiness ${piState}" title="${escapeHtml(piContextStatus)}" data-tauri-drag-region>Pi ${escapeHtml(selectedPiChoice().shortLabel)} · ${recoveryLabel(piState).toLowerCase()}</span>` : ""}
        ${sessionId ? `<span class="status" data-tauri-drag-region>${escapeHtml(sessionId.slice(0, 8))}</span>` : ""}
      </header>
      <section class="content">
        ${started ? `${sessionMode === "webapp" && remoteClients === 0 && remoteBridge ? `
          <div class="remote-pairing">
            <div>
              <div class="remote-title">Open on iPhone</div>
              <div class="remote-url">${escapeHtml(remoteBridge.url)}</div>
              <div class="remote-help">Use Safari, then Share → Add to Home Screen. This normal window and the phone stay on the same live session.</div>
            </div>
            ${remoteQrCode ? `<img class="remote-qr" src="${remoteQrCode}" alt="QR code for the iPhone session view" />` : ""}
          </div>` : ""}
          ${messages.some((message) => message.role === "assistant") ? `<div class="messages">${messages.filter((message) => message.role === "assistant").map((message) => `
          <article class="message assistant answer-pair" data-turn-id="${escapeHtml(message.turnId ?? "")}">
            <section class="answer-lane quick-lane">
              <div class="lane-header"><div class="message-role">Quick${message.quickFirstTokenMs === undefined ? "" : ` · First token ${(message.quickFirstTokenMs / 1000).toFixed(2)}s`}</div>${message.quickError ? `<button class="lane-retry" data-retry-quick="${escapeHtml(message.turnId ?? "")}" ${message.quickRetrying ? "disabled" : ""}>${message.quickRetrying ? "Retrying" : "Retry Quick"}</button>` : ""}</div>
              <div class="message-text ${message.quickContent ? "" : "waiting"}">${escapeHtml(message.quickContent || message.quickError || (message.quickDone ? "No quick answer" : "Waiting for Realtime..."))}</div>
            </section>
            <section class="answer-lane pi-lane">
              <div class="lane-header"><div class="message-role">Pi${message.firstTokenMs === undefined ? "" : ` · First token ${(message.firstTokenMs / 1000).toFixed(2)}s`}</div>${message.piError ? `<button class="lane-retry" data-retry-pi="${escapeHtml(message.turnId ?? "")}" ${message.piRetrying ? "disabled" : ""}>${message.piRetrying ? "Retrying" : "Retry Pi"}</button>` : ""}</div>
              <div class="message-text ${visiblePiContent(message.content) ? "" : "waiting"}">${escapeHtml(visiblePiContent(message.content) || message.piError || (busy && message.turnId === activeClientTurnId ? piActivity : "Waiting for Pi..."))}</div>
            </section>
          </article>`).join("")}</div>` : `<div class="empty">${sessionMode === "webapp" && remoteClients === 0 ? "Waiting for iPhone to connect" : "Transcript and answers appear here"}</div>`}` : `
          <div class="setup">
            <h1>Start a meeting session</h1>
            <p>Select one curated context folder. Supported text documents anywhere inside it are preloaded into Quick and Pi with no required filenames; it also becomes Pi's working directory.</p>
            <input id="workspace" class="input" aria-label="Context folder" placeholder="/absolute/path/to/context-folder" value="${escapeHtml(workspace)}" />
            <label>Authoritative Pi model
              <select id="pi-model" class="select" ${sessionStarting ? "disabled" : ""}>
                ${PI_MODEL_CHOICES.map((choice) => `<option value="${escapeHtml(choice.key)}" ${choice.key === selectedPiModelKey ? "selected" : ""}>${escapeHtml(choice.label)}</option>`).join("")}
              </select>
            </label>
            <div class="start-actions">
              <button id="start-overlay" class="button" ${sessionStarting ? "disabled" : ""}>${sessionStarting ? "Starting…" : "Start Overlay"}</button>
              <button id="start-webapp" class="button secondary" ${sessionStarting ? "disabled" : ""}>${sessionStarting ? "Starting…" : "Start Web App"}</button>
            </div>
            ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
          </div>`}
      </section>
      ${started ? `
        <footer class="composer">
          <div class="device-row">
            <label>Mic
              <select id="microphone" class="select" ${microphones.length ? "" : "disabled"}>
                ${microphones.length ? microphones.map((device) => `<option value="${escapeHtml(device.name)}" ${device.name === microphoneName ? "selected" : ""}>${escapeHtml(device.name)}${device.is_default ? " (Default)" : ""}</option>`).join("") : `<option>No microphone found</option>`}
              </select>
            </label>
            <div class="device-static"><span>System audio</span><strong>All app output · read only</strong></div>
          </div>
          <div class="meta">
            <span class="chip">${pendingTranscript.length} unsent transcript lines</span>
            <span class="chip" title="Acoustic echo cancellation">${escapeHtml(echoStatus)}</span>
            <span class="transcript">${escapeHtml(audioStatus)}</span>
            <span class="level" title="Live microphone input"><span id="mic-level"></span></span>
            <span class="level" title="Live speaker input"><span id="speaker-level" style="width:${Math.min(100, Math.max(2, speakerLevel * 800))}%"></span></span>
            ${screenshots.length ? `<span class="chip">${screenshots.length} screenshot${screenshots.length === 1 ? "" : "s"} ready</span>` : ""}
          </div>
          <div class="live-transcript">
            ${pendingTranscript.length
              ? pendingTranscript.map((line) => `<div>${escapeHtml(line)}</div>`).join("")
              : `<span>No unsent audio yet</span>`}
          </div>
          <textarea id="prompt" class="prompt" placeholder="Type here, or toggle passive capture with Shift + tilde">${escapeHtml(typed)}</textarea>
          <div class="actions">
            <button id="toggle" class="button secondary">${active ? "Stop keyboard" : "Capture keyboard"}</button>
            <button id="screenshot" class="button secondary">Screenshot (Option+S)</button>
            <span class="spacer"></span>
            ${busy ? `<button id="stop" class="button secondary">Stop (Option+Esc)</button>` : ""}
            <button id="send" class="button" ${allServicesReady() ? "" : "disabled"}>${allServicesReady() ? (busy ? "Stop + send" : "Send") : "Waiting for services"}</button>
          </div>
          <div class="recovery-row">
            <button id="retry-mic" class="recovery-button ${microphoneState}" ${microphoneState === "retrying" ? "disabled" : ""}>Retry Mic · ${recoveryLabel(microphoneState)}</button>
            <button id="retry-speaker" class="recovery-button ${speakerState}" ${speakerState === "retrying" ? "disabled" : ""}>Retry Speaker · ${recoveryLabel(speakerState)}</button>
            <button id="retry-quick" class="recovery-button ${quickState}" ${quickState === "retrying" ? "disabled" : ""}>Retry Quick · ${recoveryLabel(quickState)}</button>
            <button id="retry-pi" class="recovery-button ${piState}" ${piState === "retrying" ? "disabled" : ""}>Retry Pi · ${recoveryLabel(piState)}</button>
            <span class="spacer"></span>
            <button id="close-session" class="button danger" ${closingSession ? "disabled" : ""}>${closingSession ? "Closing" : "Close Session"}</button>
          </div>
          ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
        </footer>` : ""}
    </main>`;

  if (currentPrompt && promptHadFocus && currentPrompt.value === typed) {
    const template = document.createElement("template");
    template.innerHTML = markup;
    const nextRoot = template.content;
    const replaceSection = (selector: string) => {
      const current = root.querySelector(selector);
      const next = nextRoot.querySelector(selector);
      if (current && next) current.replaceWith(next);
    };
    replaceSection(".topbar");
    replaceSection(".content");
    replaceSection(".meta");
    replaceSection(".live-transcript");
    replaceSection(".actions");
    replaceSection(".recovery-row");
    const currentError = root.querySelector(".composer > .error");
    const nextError = nextRoot.querySelector(".composer > .error");
    if (currentError && nextError) currentError.replaceWith(nextError);
    else if (currentError) currentError.remove();
    else if (nextError) root.querySelector(".composer")?.append(nextError);

    bindDynamicActions();
    requestAnimationFrame(() => scrollLiveRegions(contentWasAtBottom, previousContentScrollTop));
    return;
  }

  root.innerHTML = markup;

  document.querySelector<HTMLInputElement>("#workspace")?.addEventListener("input", (event) => {
    workspace = (event.target as HTMLInputElement).value;
    try { window.localStorage.setItem("codex-overlay.workspace", workspace); } catch { /* Optional persistence. */ }
  });
  document.querySelector<HTMLSelectElement>("#pi-model")?.addEventListener("change", (event) => {
    const choice = PI_MODEL_CHOICES.find((candidate) => candidate.key === (event.target as HTMLSelectElement).value);
    if (choice && selectPiModelByKey(choice.key)) render();
  });
  document.querySelector("#start-overlay")?.addEventListener("click", () => void startSession("overlay"));
  document.querySelector("#start-webapp")?.addEventListener("click", () => void startSession("webapp"));
  const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
  prompt?.addEventListener("input", () => { typed = prompt.value; });
  prompt?.addEventListener("keydown", (event) => {
    // While passive capture is active, the native event tap is the single
    // source of keyboard input. Prevent the focused textarea from applying
    // the same key a second time; passive-* events update `typed` below.
    if (active && inputReady) {
      event.preventDefault();
      return;
    }
    if (event.altKey && event.code === "KeyS") {
      event.preventDefault();
      requestScreenshot();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });
  bindDynamicActions();
  document.querySelector<HTMLSelectElement>("#microphone")?.addEventListener("change", (event) => void changeMicrophone((event.target as HTMLSelectElement).value));
  document.querySelector<HTMLSelectElement>("#output")?.addEventListener("change", (event) => void changeOutput((event.target as HTMLSelectElement).value));
  requestAnimationFrame(() => {
    scrollLiveRegions(contentWasAtBottom, previousContentScrollTop);
    if (promptHadFocus) {
      const nextPrompt = document.querySelector<HTMLTextAreaElement>("#prompt");
      nextPrompt?.focus({ preventScroll: true });
      nextPrompt?.setSelectionRange(previousSelectionStart, previousSelectionEnd);
      if (nextPrompt) nextPrompt.scrollTop = previousPromptScrollTop;
    }
  });
}

function bindDynamicActions() {
  document.querySelector("#toggle")?.addEventListener("click", () => void toggleCapture());
  document.querySelector("#screenshot")?.addEventListener("click", requestScreenshot);
  document.querySelector("#send")?.addEventListener("click", () => void submit());
  document.querySelector("#stop")?.addEventListener("click", () => void stopPi());
  document.querySelector("#retry-mic")?.addEventListener("click", () => void retryMicrophone(false));
  document.querySelector("#retry-speaker")?.addEventListener("click", () => void retrySpeaker(false));
  document.querySelector("#retry-quick")?.addEventListener("click", () => void retryLatestQuick());
  document.querySelector("#retry-pi")?.addEventListener("click", () => void retryLatestPi());
  document.querySelector("#close-session")?.addEventListener("click", () => void closeSession());
  document.querySelectorAll<HTMLElement>("[data-retry-quick]").forEach((button) => button.addEventListener("click", () => void retryQuickTurn(button.dataset.retryQuick!, false)));
  document.querySelectorAll<HTMLElement>("[data-retry-pi]").forEach((button) => button.addEventListener("click", () => void retryPiTurn(button.dataset.retryPi!, false)));
}

function scrollLiveRegions(followContent: boolean, previousContentScrollTop: number) {
  const content = document.querySelector<HTMLElement>(".content");
  if (content) {
    content.scrollTop = followContent ? content.scrollHeight : previousContentScrollTop;
  }
  const live = document.querySelector<HTMLElement>(".live-transcript");
  if (live) live.scrollTop = live.scrollHeight;
}

function updateStreamingLane(turnId: string, lane: "quick" | "pi") {
  scheduleRemoteSnapshot();
  scheduleHistoryCheckpoint();
  const assistant = assistantForTurn(turnId);
  if (!assistant) return;
  const content = document.querySelector<HTMLElement>(".content");
  const article = document.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
  const laneElement = article?.querySelector<HTMLElement>(`.${lane}-lane`);
  const textElement = laneElement?.querySelector<HTMLElement>(".message-text");
  if (!content || !laneElement || !textElement) {
    render();
    return;
  }
  const wasAtBottom = content.scrollHeight - content.scrollTop - content.clientHeight <= 24;
  const value = lane === "quick"
    ? assistant.quickContent || assistant.quickError || (assistant.quickDone ? "No quick answer" : "Waiting for Realtime...")
    : visiblePiContent(assistant.content) || assistant.piError || (busy && assistant.turnId === activeClientTurnId ? piActivity : "Waiting for Pi...");
  textElement.textContent = value;
  textElement.classList.toggle("waiting", lane === "quick" ? !assistant.quickContent : !visiblePiContent(assistant.content));
  const role = laneElement.querySelector<HTMLElement>(".message-role");
  if (role) {
    const latency = lane === "quick" ? assistant.quickFirstTokenMs : assistant.firstTokenMs;
    role.textContent = `${lane === "quick" ? "Quick" : "Pi"}${latency === undefined ? "" : ` · First token ${(latency / 1000).toFixed(2)}s`}`;
  }
  if (wasAtBottom) requestAnimationFrame(() => { content.scrollTop = content.scrollHeight; });
}

function updateLiveTranscriptUi() {
  scheduleRemoteSnapshot();
  scheduleHistoryCheckpoint();
  const live = document.querySelector<HTMLElement>(".live-transcript");
  if (!live) return;
  const lines = pendingTranscriptLines();
  live.replaceChildren();
  if (lines.length) {
    for (const line of lines) {
      const row = document.createElement("div");
      row.textContent = line;
      live.append(row);
    }
  } else {
    const empty = document.createElement("span");
    empty.textContent = "No unsent audio yet";
    live.append(empty);
  }
  live.scrollTop = live.scrollHeight;
}

async function ensureRemoteBridge() {
  if (remoteBridge) return remoteBridge;
  remoteBridge = await invoke<RemoteBridgeInfo>("start_remote_bridge");
  remoteClients = remoteBridge.connectedClients;
  remoteQrCode = await QRCode.toDataURL(remoteBridge.url, {
    width: 220,
    margin: 1,
    color: { dark: "#050506", light: "#ffffff" },
  });
  scheduleRemoteSnapshot(true);
  return remoteBridge;
}

async function initializeRemoteBridge() {
  try {
    await ensureRemoteBridge();
    render();
    scheduleRemoteSnapshot(true);
  } catch (cause) {
    remoteBridge = null;
    remoteQrCode = "";
    error = `Could not start the iPhone view: ${String(cause)}`;
    render();
  }
}

async function startSession(mode: SessionMode, activateWindow = true) {
  if (started || sessionStarting || closingSession) return;
  sessionStarting = true;
  sessionMode = mode;
  liveTranscript = null;
  error = "";
  render();
  let epoch = sessionEpoch;
  try {
    await historyInitialization;
    if (historyPersistenceError) {
      throw new Error(`Session history is unavailable: ${historyPersistenceError}`);
    }
    const selection = selectedPiChoice();
    const appVersion = await invoke<string>("get_app_version");
    const persistedId = crypto.randomUUID();
    const persistedStartedAt = Date.now();
    await createSessionRecord({
      id: persistedId,
      startedAt: persistedStartedAt,
      mode,
      workspace,
      piProvider: selection.provider,
      piModel: selection.model,
      appVersion,
    });
    historySessionId = persistedId;
    historySessionStartedAt = persistedStartedAt;
    historyEventSequence = 0;
    recordHistoryEvent("session_start_requested", {
      mode,
      workspace,
      piProvider: selection.provider,
      piModel: selection.model,
    });
    if (mode === "webapp") {
      await ensureRemoteBridge();
      await invoke("set_main_window_mode", { mode: "normal", activate: activateWindow });
    } else {
      remoteClients = 0;
      await invoke("set_main_window_mode", { mode: "overlay", activate: true });
    }
    epoch = ++sessionEpoch;
    started = true;
    closingSession = false;
    realtimeContextStatus = "Loading Quick context";
    piPreparing = true;
    piContextStatus = "Loading full context folder";
    quickState = "starting";
    piState = "starting";
    microphoneState = "starting";
    speakerState = "starting";
    error = "";
    recordHistoryEvent("session_active");
    render();

    void recoverRealtime(true, epoch);
    void recoverPi(true, epoch);

    await invoke("update_shortcuts", {
      config: { bindings: { toggle_passive: { action: "toggle_passive", key: "Shift+Backquote", enabled: true } } },
    });
    if (epoch !== sessionEpoch || closingSession || !started) return;
    if (mode === "webapp") {
      active = true;
      await invoke("set_passive_capture", { active: true });
      if (epoch !== sessionEpoch || closingSession || !started) return;
    }
    const permissions = await import("tauri-plugin-macos-permissions-api");
    if (!(await permissions.checkMicrophonePermission())) {
      await permissions.requestMicrophonePermission();
      for (let attempt = 0; attempt < 20 && !(await permissions.checkMicrophonePermission()); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!(await permissions.checkMicrophonePermission())) throw new Error("Microphone permission was not granted");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (epoch !== sessionEpoch || closingSession || !started) return;
    await loadAudioDevices();
    if (epoch !== sessionEpoch || closingSession || !started) return;
    render();
    await retryMicrophone(true, epoch);
    if (epoch !== sessionEpoch || closingSession || !started) return;
    await loadAudioDevices(true);
    if (epoch !== sessionEpoch || closingSession || !started) return;
    render();
    await retrySpeaker(true, epoch);
  } catch (cause) {
    if (epoch === sessionEpoch && !closingSession) {
      error = started ? String(cause) : `Could not start the session: ${String(cause)}`;
      recordHistoryEvent("session_start_error", { error });
      if (!started && historySessionId) {
        const failedId = historySessionId;
        const failedSnapshot = persistedSnapshot();
        const failedTurns = persistedTurns();
        try {
          await queueHistoryWrite(() => finishSessionRecord(
            failedId,
            "failed",
            failedSnapshot,
            failedTurns,
            error,
          ));
        } finally {
          historySessionId = "";
          historySessionStartedAt = 0;
          historyEventSequence = 0;
        }
      }
    }
  } finally {
    if (!started || epoch === sessionEpoch) sessionStarting = false;
    render();
  }
}

async function recoverRealtime(automatic: boolean, epoch = sessionEpoch) {
  if (!started || closingSession || epoch !== sessionEpoch || quickState === "retrying") return false;
  quickState = "retrying";
  realtimeContextStatus = automatic ? "Recovering Quick automatically" : "Retrying Quick connection";
  render();
  let lastError = "";
  for (let attempt = 0; attempt < 3 && epoch === sessionEpoch && !closingSession; attempt++) {
    try {
      const context = await invoke<ContextInfo>("start_realtime_session", { workspace });
      quickState = "ready";
      realtimeContextStatus = `${context.file_count} files · ${context.version}`;
      render();
      return true;
    } catch (cause) {
      lastError = String(cause);
      if (attempt < 2) await wait(500 * (2 ** attempt));
    }
  }
  if (epoch !== sessionEpoch || closingSession) return false;
  quickState = "failed";
  realtimeContextStatus = lastError || "Quick recovery failed";
  error = `Realtime: ${realtimeContextStatus}`;
  render();
  return false;
}

async function recoverPi(automatic: boolean, epoch = sessionEpoch) {
  if (!started || closingSession || epoch !== sessionEpoch || piState === "retrying") return;
  piState = "retrying";
  piPreparing = true;
  piContextStatus = automatic ? "Recovering Pi automatically" : "Retrying Pi session";
  render();
  let lastError = "";
  for (let attempt = 0; attempt < 2 && epoch === sessionEpoch && !closingSession; attempt++) {
    try {
      const selection = selectedPiChoice();
      const context = await invoke<ContextInfo>("start_pi_session", {
        workspace,
        provider: selection.provider,
        model: selection.model,
        thinkingLevel: selection.thinkingLevel,
        nitro: Boolean(selection.nitro),
      });
      piPreparing = false;
      piState = "ready";
      piContextStatus = `${context.file_count} files · ${context.version}`;
      render();
      return;
    } catch (cause) {
      lastError = String(cause);
      if (attempt === 0) await wait(750);
    }
  }
  if (epoch !== sessionEpoch || closingSession) return;
  piPreparing = false;
  piState = "failed";
  piContextStatus = lastError || "Pi recovery failed";
  error = `Pi: ${piContextStatus}`;
  render();
}

async function retryMicrophone(automatic: boolean, epoch = sessionEpoch) {
  if (!started || closingSession || epoch !== sessionEpoch || microphoneState === "retrying") return;
  microphoneState = "retrying";
  audioStatus = automatic ? "Recovering microphone transcription" : "Retrying microphone";
  render();
  let lastError = "";
  for (let attempt = 0; attempt < 3 && epoch === sessionEpoch && !closingSession; attempt++) {
    try {
      await invoke("stop_microphone_capture").catch(() => {});
      await invoke("start_microphone_capture", { deviceName: microphoneName || null });
      microphoneState = "ready";
      audioStatus = `Mic verified${microphoneName ? ` · ${microphoneName}` : ""}`;
      render();
      return;
    } catch (cause) {
      lastError = String(cause);
      if (attempt < 2) await wait(500 * (2 ** attempt));
    }
  }
  if (epoch !== sessionEpoch || closingSession) return;
  microphoneState = "failed";
  audioStatus = "Microphone transcription unavailable";
  error = `Microphone: ${lastError}`;
  render();
}

async function retrySpeaker(automatic: boolean, epoch = sessionEpoch) {
  if (!started || closingSession || epoch !== sessionEpoch || speakerState === "retrying") return;
  if (speakerRecoveryTimer !== undefined) {
    window.clearTimeout(speakerRecoveryTimer);
    speakerRecoveryTimer = undefined;
  }
  speakerState = "retrying";
  audioStatus = automatic ? "Recovering speaker transcription" : "Retrying speaker capture";
  render();
  let lastError = "";
  for (let attempt = 0; attempt < 1 && epoch === sessionEpoch && !closingSession; attempt++) {
    try {
      await invoke("stop_system_audio_capture").catch(() => {});
      await invoke("start_system_audio_capture", { deviceId: outputId || null });
      const name = outputs.find((device) => device.id === outputId)?.name;
      if (speakerState === "retrying") {
        audioStatus = `Speaker capture starting${name ? ` · ${name}` : ""}`;
      }
      render();
      return;
    } catch (cause) {
      lastError = String(cause);
    }
  }
  if (epoch !== sessionEpoch || closingSession) return;
  speakerState = "failed";
  speakerLevel = 0;
  liveTranscript = null;
  audioStatus = "Speaker transcription unavailable";
  error = `Speaker: ${lastError}`;
  render();
}

async function loadAudioDevices(preserveSelections = false) {
  const previousMicrophone = microphoneName;
  const previousOutput = outputId;
  const [microphoneResult, outputResult] = await Promise.allSettled([
    invoke<MicrophoneDevice[]>("get_microphone_devices"),
    invoke<AudioDevice[]>("get_output_devices"),
  ]);
  if (microphoneResult.status === "fulfilled") {
    microphones = microphoneResult.value;
    microphoneName = preserveSelections && microphones.some((device) => device.name === previousMicrophone)
      ? previousMicrophone
      : microphones.find((device) => device.is_default)?.name ?? microphones[0]?.name ?? "";
  }
  if (outputResult.status === "fulfilled") {
    outputs = outputResult.value;
    outputId = preserveSelections && outputs.some((device) => device.id === previousOutput)
      ? previousOutput
      : outputs.find((device) => device.is_default)?.id ?? outputs[0]?.id ?? "";
  }
}

async function changeMicrophone(name: string) {
  microphoneName = name;
  microphoneState = "failed";
  await retryMicrophone(false);
}

async function changeOutput(id: string) {
  outputId = id;
  speakerState = "failed";
  await retrySpeaker(false);
}

async function toggleCapture() {
  active = !active;
  await invoke("set_passive_capture", { active });
  render();
}

async function captureScreenshot() {
  try {
    const permissions = await import("tauri-plugin-macos-permissions-api");
    if (!(await permissions.checkScreenRecordingPermission())) {
      await permissions.requestScreenRecordingPermission();
      error = "Screen Recording permission was requested. Enable Codex Overlay in System Settings, then quit and reopen the app before taking a screenshot.";
      render();
      return;
    }
    const captured = await invoke<{ path: string }>("capture_screen_file");
    if (!screenshots.some((image) => image.path === captured.path)) {
      screenshots.push({ path: captured.path });
      recordHistoryEvent("screenshot_captured", { path: captured.path });
    }
    error = "";
  } catch (cause) {
    const permissions = await import("tauri-plugin-macos-permissions-api");
    await permissions.requestScreenRecordingPermission().catch(() => {});
    error = `Screenshot failed: ${String(cause)}. Enable Screen & System Audio Recording, then quit and reopen Codex Overlay.`;
  }
  render();
}

function requestScreenshot() {
  screenshotCaptureQueue += 1;
  if (screenshotCaptureInFlight) return;
  void drainScreenshotQueue();
}

async function drainScreenshotQueue() {
  screenshotCaptureInFlight = true;
  try {
    while (screenshotCaptureQueue > 0) {
      screenshotCaptureQueue -= 1;
      await captureScreenshot();
    }
  } finally {
    screenshotCaptureInFlight = false;
  }
}

async function submit() {
  if (!started) return;
  if (!allServicesReady()) {
    error = `Cannot send until all services are ready${failedServices().length ? ` · failed: ${failedServices().join(", ")}` : ""}`;
    render();
    return;
  }
  const unsent = pendingTranscriptLines();
  const hasPayload = Boolean(typed.trim() || unsent.length || screenshots.length);
  if (busy) {
    if (!hasPayload) return;
    await abortPiTurn();
  }
  if (!typed.trim() && !unsent.length && !screenshots.length) return;
  const sections = [
    unsent.length ? `New transcript context since the previous turn:\n${unsent.join("\n")}` : "",
    typed.trim() ? `Manual input:\n${typed.trim()}` : "",
  ].filter(Boolean);
  for (const source of ["You", "Speaker"] as TranscriptSource[]) {
    for (const word of finalizedWords[source]) word.sent = true;
    for (const word of activeWords[source]) word.sent = true;
    for (const word of [...finalizedWords[source], ...activeWords[source]]) {
      if (word.utterance === utteranceGeneration[source]) {
        sentAudioThrough[source] = Math.max(sentAudioThrough[source], word.end);
      }
    }
  }
  const imagePaths = screenshots.map((image) => image.path);
  const userContent = sections.join("\n\n") || `${screenshots.length} screenshot${screenshots.length === 1 ? "" : "s"} attached`;
  const turnId = `turn-${++clientTurnCounter}`;
  const startedAt = performance.now();
  const submittedAtEpoch = Date.now();
  messages.push({
    role: "user",
    content: userContent,
    imagePaths,
    piPrompt: sections.join("\n\n"),
    turnId,
    submittedAtEpoch,
    manualText: typed.trim() || undefined,
    transcriptLines: [...unsent],
  });
  messages.push({ role: "assistant", content: "", turnId, startedAt, submittedAtEpoch });
  recordHistoryEvent("turn_submitted", {
    prompt: userContent,
    manualText: typed.trim() || null,
    transcriptLines: unsent,
    screenshotPaths: imagePaths,
  }, { turnId });
  typed = "";
  screenshots = [];
  const generation = ++turnGeneration;
  activeClientTurnId = turnId;
  busy = true;
  piActivity = "Starting Pi...";
  error = "";
  render();
  void sendQuickTurn(turnId, userContent, imagePaths, generation);
  await sendPiTurnWithRecovery(turnId, sections.join("\n\n"), imagePaths, generation);
  if (generation === turnGeneration) {
    busy = false;
    render();
  }
}

async function sendQuickTurn(
  turnId: string,
  prompt: string,
  imagePaths: string[],
  generation: number,
) {
  const assistant = assistantForTurn(turnId);
  armQuickWatchdog(turnId, 75_000, "first token");
  try {
    await invoke("send_realtime_turn", { turnId, prompt, imagePaths });
    if (generation === turnGeneration) quickState = "ready";
  } catch (cause) {
    clearQuickWatchdog(turnId);
    if (!assistant || generation !== turnGeneration) return;
    assistant.quickError = String(cause);
    quickState = "failed";
    render();
    const recovered = await recoverRealtime(true);
    if (recovered) await retryQuickTurn(turnId, true);
  }
}

async function retryQuickTurn(turnId: string, automatic: boolean) {
  const assistant = assistantForTurn(turnId);
  if (!assistant || assistant.quickRetrying || closingSession) return;
  if (!automatic) assistant.quickRetries = 0;
  const retries = assistant.quickRetries ?? 0;
  if (automatic && retries >= 2) return;
  assistant.quickRetries = retries + 1;
  assistant.quickRetrying = true;
  assistant.quickError = undefined;
  assistant.quickContent = "";
  assistant.quickDone = false;
  assistant.completedAtEpoch = undefined;
  assistant.quickFirstTokenMs = undefined;
  assistant.startedAt = performance.now();
  quickState = "retrying";
  render();
  armQuickWatchdog(turnId, 75_000, "first token");
  try {
    await invoke("retry_realtime_turn", { turnId });
    quickState = "ready";
  } catch (cause) {
    clearQuickWatchdog(turnId);
    assistant.quickError = String(cause);
    quickState = "failed";
  } finally {
    assistant.quickRetrying = false;
    render();
  }
}

async function sendPiTurnWithRecovery(
  turnId: string,
  prompt: string,
  imagePaths: string[],
  generation: number,
) {
  const assistant = assistantForTurn(turnId);
  const ready = await waitForPiReady(generation);
  if (!ready) {
    if (assistant && generation === turnGeneration && !closingSession) {
      assistant.piError = "Pi did not become ready";
      piState = "failed";
      render();
    }
    return;
  }
  try {
    await invoke("send_pi_turn", { prompt, imagePaths });
    if (!assistant || generation !== turnGeneration || closingSession) return;
    assistant.piRetrying = false;
    assistant.piError = undefined;
    piState = "ready";
    return;
  } catch (cause) {
    if (!assistant || generation !== turnGeneration || closingSession) return;
    assistant.piRetrying = false;
    assistant.piError = String(cause);
    error = `Pi: ${assistant.piError}`;
    render();
  }
}

async function waitForPiReady(generation: number) {
  const deadline = Date.now() + 35_000;
  let attemptedRecovery = false;
  while (Date.now() < deadline && generation === turnGeneration && !closingSession) {
    if (piState === "ready" && !piPreparing) return true;
    if (piState === "failed" && !attemptedRecovery) {
      attemptedRecovery = true;
      await recoverPi(true);
      continue;
    }
    await wait(100);
  }
  return false;
}

async function retryPiTurn(turnId: string, automatic: boolean) {
  const assistant = assistantForTurn(turnId);
  const user = messages.find((message) => message.role === "user" && message.turnId === turnId);
  if (!assistant || !user || assistant.piRetrying || closingSession) return;
  if (!automatic) assistant.piRetries = 0;
  if (automatic && (assistant.piRetries ?? 0) >= 1) return;
  assistant.piRetries = (assistant.piRetries ?? 0) + 1;
  assistant.piRetrying = true;
  assistant.piError = undefined;
  assistant.content = "";
  assistant.piDone = false;
  assistant.piStopped = false;
  assistant.completedAtEpoch = undefined;
  assistant.itemId = undefined;
  assistant.firstTokenMs = undefined;
  assistant.startedAt = performance.now();
  const generation = ++turnGeneration;
  activeClientTurnId = turnId;
  busy = true;
  render();
  await sendPiTurnWithRecovery(
    turnId,
    user.piPrompt ?? user.content,
    user.imagePaths ?? [],
    generation,
  );
  if (generation === turnGeneration) {
    busy = false;
    render();
  }
}

async function retryLatestQuick() {
  const failed = [...messages].reverse().find((message) => message.role === "assistant" && message.quickError && message.turnId);
  if (failed?.turnId) await retryQuickTurn(failed.turnId, false);
  else await recoverRealtime(false);
}

async function retryLatestPi() {
  const failed = [...messages].reverse().find((message) => message.role === "assistant" && message.piError && message.turnId);
  if (failed?.turnId) await retryPiTurn(failed.turnId, false);
  else await recoverPi(false);
}

async function retryFailedServices() {
  if (!started || closingSession) return;
  const retryQuick = quickState === "failed";
  const retryPi = piState === "failed";
  const retryMicrophoneNow = microphoneState === "failed";
  const retrySpeakerNow = speakerState === "failed";
  const aiRetries = Promise.allSettled([
    ...(retryQuick ? [retryLatestQuick()] : []),
    ...(retryPi ? [retryLatestPi()] : []),
  ]);
  if (retryMicrophoneNow) await retryMicrophone(false);
  if (retrySpeakerNow) await retrySpeaker(false);
  await aiRetries;
}

async function abortPiTurn() {
  if (piStopPromise) return piStopPromise;
  ++turnGeneration;
  piActivity = "Stopping this answer...";
  const assistant = assistantForTurn(activeClientTurnId);
  if (assistant) assistant.piStopped = true;
  recordHistoryEvent("pi_stopped", {}, { turnId: activeClientTurnId || undefined });
  render();
  piStopPromise = (async () => {
    await invoke("stop_pi_turn").catch((cause) => { error = String(cause); });
    busy = false;
    piPreparing = false;
    piState = "ready";
    piActivity = "Pi is ready";
    render();
  })().finally(() => {
    piStopPromise = undefined;
  });
  return piStopPromise;
}

async function stopPi() {
  return abortPiTurn();
}

async function closeSession() {
  if (!started || closingSession) return;
  closingSession = true;
  for (const turnId of [...quickWatchdogs.keys()]) clearQuickWatchdog(turnId);
  recordHistoryEvent("session_end_requested");
  if (speakerRecoveryTimer !== undefined) {
    window.clearTimeout(speakerRecoveryTimer);
    speakerRecoveryTimer = undefined;
  }
  ++sessionEpoch;
  ++turnGeneration;
  busy = false;
  active = false;
  quickState = "closed";
  piState = "closed";
  microphoneState = "closed";
  speakerState = "closed";
  audioStatus = "Closing session";
  render();
  const results = await Promise.allSettled([
    invoke("set_passive_capture", { active: false }),
    invoke("stop_microphone_capture"),
    invoke("stop_system_audio_capture"),
    invoke("close_realtime_session"),
    invoke("close_pi_session"),
  ]);
  const failures = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
  const cleanupWarning = failures.length
    ? `Session closed with cleanup warnings: ${failures.map((failure) => String(failure.reason)).join("; ")}`
    : "";
  if (cleanupWarning) error = cleanupWarning;
  const completedStatus = failures.length ? "completed_with_warnings" : "completed";
  recordHistoryEvent("session_ended", {
    status: completedStatus,
    cleanupWarnings: failures.map((failure) => String(failure.reason)),
  });
  if (historyCheckpointTimer !== undefined) {
    window.clearTimeout(historyCheckpointTimer);
    historyCheckpointTimer = undefined;
  }
  const completedHistoryId = historySessionId;
  if (completedHistoryId) {
    const finalSnapshot = persistedSnapshot();
    const finalTurns = persistedTurns();
    try {
      await queueHistoryWrite(() => finishSessionRecord(
        completedHistoryId,
        completedStatus,
        finalSnapshot,
        finalTurns,
        cleanupWarning || undefined,
      ));
    } catch (cause) {
      historyPersistenceError = String(cause);
    }
  }
  historySessionId = "";
  historySessionStartedAt = 0;
  historyEventSequence = 0;
  messages.splice(0);
  for (const source of ["You", "Speaker"] as TranscriptSource[]) {
    finalizedWords[source] = [];
    activeWords[source] = [];
    finalizedThrough[source] = -1;
    sentAudioThrough[source] = -1;
    utteranceGeneration[source] = 0;
    utteranceOrder[source] = 0;
  }
  nextUtteranceOrder = 0;
  typed = "";
  screenshots = [];
  sessionId = "";
  activeClientTurnId = "";
  piPreparing = false;
  realtimeContextStatus = "Quick context pending";
  piContextStatus = "Pi context pending";
  audioStatus = "Audio starting";
  echoStatus = "AEC starting";
  speakerLevel = 0;
  started = false;
  sessionStarting = false;
  closingSession = false;
  error = historyPersistenceError
    ? `Session ended, but saving history failed: ${historyPersistenceError}`
    : cleanupWarning;
  render();
}

await listen<string>("passive-key", ({ payload }) => {
  typed += payload;
  render();
});
await listen("passive-backspace", () => {
  typed = typed.slice(0, -1);
  render();
});
await listen("passive-screenshot", () => {
  requestScreenshot();
});
await listen("passive-submit", () => {
  void submit();
});
await listen("passive-stop", () => void stopPi());
await listen<string>("passive-input-error", ({ payload }) => { inputReady = false; error = payload; render(); });
await listen("passive-input-ready", () => { inputReady = true; error = ""; render(); });

// The native event tap can become ready before the webview has attached its
// listeners. Polling the persisted native state prevents a stale permission
// warning after launch or after permission is granted in System Settings.
async function refreshPassiveInputReady() {
  try {
    const ready = await invoke<boolean>("get_passive_input_ready");
    if (ready !== inputReady) {
      inputReady = ready;
      if (ready && error.includes("Input Monitoring")) error = "";
      render();
    }
  } catch {
    // The native listener remains authoritative; retry on the next interval.
  }
}
void refreshPassiveInputReady();
window.setInterval(() => void refreshPassiveInputReady(), 1_000);
await listen<number>("remote-client-count", ({ payload }) => {
  remoteClients = payload;
  render();
});
await listen<string>("remote-bridge-error", ({ payload }) => {
  error = `iPhone view: ${payload}`;
  render();
});
await listen<{ action?: string; provider?: string; model?: string; modelKey?: string }>("remote-control", ({ payload }) => {
  if (payload.action === "screenshot") requestScreenshot();
  else if (payload.action === "send" && !busy && allServicesReady()) void submit();
  else if (payload.action === "stop_send" && allServicesReady()) void submit();
  else if (payload.action === "retry_failed" && failedServices().length) void retryFailedServices();
  else if (payload.action === "select_model" && !started && !sessionStarting) {
    if (payload.modelKey ? selectPiModelByKey(payload.modelKey) : payload.provider && payload.model && selectPiModel(payload.provider, payload.model)) render();
  } else if (payload.action === "start_session" && !started && !sessionStarting && !closingSession) {
    if (payload.modelKey) {
      if (!selectPiModelByKey(payload.modelKey)) return;
    } else if (payload.provider && payload.model && !selectPiModel(payload.provider, payload.model)) {
      return;
    }
    void startSession("webapp", false);
  }
  else if (payload.action === "end_session" && sessionMode === "webapp" && started && !closingSession) void closeSession();
});
await listen<string>("pi-session", ({ payload }) => {
  sessionId = payload;
  recordHistoryEvent("pi_session_ready", { piSessionId: payload });
  render();
});
await listen<ContextInfo>("realtime-context-ready", ({ payload }) => {
  quickState = "ready";
  realtimeContextStatus = `${payload.file_count} files · ${payload.version}`;
  render();
});
await listen<PreparationStatus>("pi-preparation-status", ({ payload }) => {
  piPreparing = payload.phase === "preparing";
  piState = payload.phase === "ready" ? "ready" : payload.phase === "error" ? "failed" : "retrying";
  piContextStatus = payload.context
    ? `${payload.message} · ${payload.context.file_count} files · ${payload.context.version}`
    : payload.message;
  render();
});
await listen<{ turn_id: string; delta: string }>("realtime-answer-delta", ({ payload }) => {
  const assistant = assistantForTurn(payload.turn_id);
  if (!assistant) return;
  if (!assistant.quickContent) {
    assistant.quickFirstTokenMs = performance.now() - (assistant.startedAt ?? performance.now());
  }
  assistant.quickError = undefined;
  assistant.quickRetrying = false;
  quickState = "ready";
  assistant.quickContent = (assistant.quickContent ?? "") + payload.delta;
  armQuickWatchdog(payload.turn_id, 40_000, "stream");
  updateStreamingLane(payload.turn_id, "quick");
});
await listen<{ turn_id: string; text: string }>("realtime-answer-done", ({ payload }) => {
  clearQuickWatchdog(payload.turn_id);
  const assistant = assistantForTurn(payload.turn_id);
  if (!assistant) return;
  if (!assistant.quickContent && payload.text) {
    assistant.quickContent = payload.text;
    assistant.quickFirstTokenMs = performance.now() - (assistant.startedAt ?? performance.now());
  }
  assistant.quickDone = true;
  assistant.quickRetrying = false;
  assistant.quickError = undefined;
  quickState = "ready";
  if (assistant.piDone) assistant.completedAtEpoch = Date.now();
  recordHistoryEvent("quick_answer_completed", { answer: assistant.quickContent }, { turnId: payload.turn_id });
  render();
});
await listen<{ turn_id?: string; message: string }>("realtime-error", ({ payload }) => {
  if (payload.turn_id) clearQuickWatchdog(payload.turn_id);
  const assistant = payload.turn_id ? assistantForTurn(payload.turn_id) : undefined;
  if (assistant) {
    quickState = "failed";
    assistant.quickError = payload.message;
    assistant.quickRetrying = false;
    recordHistoryEvent("quick_answer_error", { error: payload.message }, { turnId: payload.turn_id });
    const delay = payload.message.toLowerCase().includes("rate limit") ? 15_000 : 750;
    if ((assistant.quickRetries ?? 0) < 2 && started && !closingSession) {
      window.setTimeout(() => void retryQuickTurn(payload.turn_id!, true), delay);
    }
  } else {
    const wasRetrying = quickState === "retrying";
    if (!wasRetrying) quickState = "failed";
    error = `Realtime: ${payload.message}`;
    recordHistoryEvent("quick_service_error", { error: payload.message });
    if (started && !closingSession && !wasRetrying) {
      window.setTimeout(() => void recoverRealtime(true), 750);
    }
  }
  render();
});
await listen<GrokTranscript>("grok-transcript-update", ({ payload }) => {
  applyTranscriptUpdate(payload);
  const text = payload.text.trim();
  if (text) liveTranscript = { source: payload.source, text };
  if (payload.is_final || payload.speech_final) {
    recordHistoryEvent("transcript_finalized", {
      text: payload.text,
      words: payload.words,
      isFinal: payload.is_final,
      speechFinal: payload.speech_final,
      start: payload.start,
      duration: payload.duration,
    }, { source: payload.source });
  }
  audioStatus = `${payload.source}: ${payload.text}`;
  updateLiveTranscriptUi();
});
await listen<string>("grok-transcription-ready", ({ payload }) => {
  if (payload === "You") microphoneState = "ready";
  audioStatus = payload === "Speaker"
    ? "Speaker STT ready · waiting for system audio"
    : `${payload} Grok STT ready`;
  render();
});
await listen<string>("echo-cancellation-status", ({ payload }) => {
  echoStatus = payload;
  render();
});
await listen<string>("grok-transcription-error", ({ payload }) => {
  const microphone = payload.startsWith("You ");
  const alreadyRetrying = microphone ? microphoneState === "retrying" : speakerState === "retrying";
  if (microphone && !alreadyRetrying) microphoneState = "failed";
  if (!microphone && !alreadyRetrying) speakerState = "failed";
  audioStatus = microphone ? "Microphone transcription unavailable" : "Speaker transcription unavailable";
  error = payload;
  recordHistoryEvent("transcription_error", { error: payload }, { source: microphone ? "You" : "Speaker" });
  render();
  if (microphone && started && !closingSession && !alreadyRetrying) {
    window.setTimeout(() => void retryMicrophone(true), 750);
  }
  if (!microphone && !alreadyRetrying) scheduleSpeakerRecovery();
});
await listen<string>("microphone-ready", ({ payload }) => { microphoneState = "ready"; audioStatus = `Mic open: ${payload}`; render(); });
await listen<number>("capture-started", ({ payload }) => {
  speakerState = "ready";
  if (error.startsWith("Speaker:")) error = "";
  audioStatus = `Speaker capture live · ${payload} Hz`;
  render();
});
await listen<string>("speaker-capture-error", ({ payload }) => {
  speakerState = "failed";
  speakerLevel = 0;
  audioStatus = payload;
  error = `Speaker: ${payload}`;
  recordHistoryEvent("speaker_capture_error", { error: payload });
  render();
  scheduleSpeakerRecovery();
});
await listen<number>("speaker-level", ({ payload }) => {
  speakerLevel = payload;
  const meter = document.querySelector<HTMLElement>("#speaker-level");
  if (meter) meter.style.width = `${Math.min(100, Math.max(2, payload * 800))}%`;
});
await listen<number>("microphone-level", ({ payload }) => {
  const meter = document.querySelector<HTMLElement>("#mic-level");
  if (meter) meter.style.width = `${Math.min(100, Math.max(2, payload * 800))}%`;
});
await listen<string>("microphone-error", ({ payload }) => {
  const wasRetrying = microphoneState === "retrying";
  audioStatus = "Microphone unavailable";
  error = `Microphone: ${payload}`;
  recordHistoryEvent("microphone_capture_error", { error: payload });
  if (wasRetrying) {
    render();
    return;
  }
  microphoneState = "failed";
  render();
  if (started && !closingSession) {
    window.setTimeout(() => void retryMicrophone(true), 750);
  }
});
await listen<string>("pi-event", ({ payload }) => {
  try {
    const event = JSON.parse(payload);
    if (event.event === "session_ready") {
      piState = "ready";
      piActivity = "Pi is ready";
      if (!piPreparing) {
        piContextStatus = event.serviceTier
          ? `${event.model ?? "gpt-5.6-terra"} · ${event.serviceTier}`
          : event.provider === "cursor"
            ? `${event.model ?? "gpt-5.6-terra@272k:fast"} · Cursor`
            : event.provider === "openrouter"
              ? `${event.model ?? "z-ai/glm-5.3-flash"} · OpenRouter`
              : (event.model ?? "gpt-5.6-terra");
      }
      render();
    } else if (["prompt_accepted", "agent_start", "turn_start"].includes(event.event)) {
      piActivity = "Pi is working...";
      updateStreamingLane(activeClientTurnId, "pi");
    } else if (event.event === "thinking_delta") {
      piActivity = "Pi is reasoning...";
      updateStreamingLane(activeClientTurnId, "pi");
    } else if (event.event === "tool_start") {
      piActivity = "Pi is reading workspace files...";
      updateStreamingLane(activeClientTurnId, "pi");
    } else if (event.event === "tool_end") {
      piActivity = "Pi is preparing the answer...";
      updateStreamingLane(activeClientTurnId, "pi");
    } else if (event.event === "text_delta") {
      const assistant = assistantForTurn(activeClientTurnId);
      if (assistant && typeof event.delta === "string") {
        assistant.content += event.delta;
        if (assistant.firstTokenMs === undefined) {
          assistant.firstTokenMs = performance.now() - (assistant.startedAt ?? performance.now());
        }
      }
      piActivity = "Writing answer...";
      piState = "ready";
      updateStreamingLane(activeClientTurnId, "pi");
    } else if (event.event === "turn_complete") {
      const assistant = assistantForTurn(activeClientTurnId);
      if (assistant) {
        assistant.piDone = true;
        if (assistant.quickDone) assistant.completedAtEpoch = Date.now();
        syncPiAnswer(assistant, assistant.content);
        recordHistoryEvent("pi_answer_completed", {
          answer: visiblePiContent(assistant.content),
        }, { turnId: activeClientTurnId });
      }
      busy = false;
      piState = "ready";
      piActivity = "Pi is thinking...";
      render();
    } else if (event.event === "retry") {
      piActivity = "Pi is retrying...";
      render();
    } else if (event.event === "compaction_start") {
      piActivity = "Pi is compacting context...";
      render();
    } else if (event.event === "empty_response_recovery") {
      piActivity = "Pi is recovering the final answer...";
      render();
    } else if (event.event === "timeout") {
      piActivity = "Pi hit the deadline · aborting this turn...";
      render();
    } else if (event.event === "turn_aborted" || event.event === "turn_replaced") {
      busy = false;
      piState = "ready";
      piActivity = "Pi is ready";
      render();
    } else if (event.event === "error") {
      busy = false;
      const message = event.message ?? "Pi failed";
      const assistant = assistantForTurn(activeClientTurnId);
      if (assistant) assistant.piError = message;
      recordHistoryEvent("pi_answer_error", { error: message }, { turnId: activeClientTurnId || undefined });
      const lost = /bridge stopped|bridge is unavailable|Failed to write to Pi bridge|response channel closed/i.test(message);
      piState = lost ? "failed" : "ready";
      piActivity = lost ? "Pi worker died" : "Pi is ready";
      error = message;
      render();
    }
  } catch { /* Ignore malformed Pi diagnostics. */ }
});
await listen<{ action?: string }>("custom-shortcut-triggered", ({ payload }) => {
  if (payload.action === "toggle_passive") void toggleCapture();
});

render();
void initializeRemoteBridge();
