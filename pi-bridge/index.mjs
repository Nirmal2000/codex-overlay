import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { imagesFromPaths } from "./images.mjs";
import { createWebSearchTool } from "./web-search.mjs";

const protocolWrite = process.stdout.write.bind(process.stdout);
const logToStderr = (...values) => process.stderr.write(`${values.map(formatLog).join(" ")}\n`);
console.log = logToStderr;
console.info = logToStderr;
console.warn = logToStderr;
console.error = logToStderr;

const {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import("@earendil-works/pi-coding-agent");

const PI_TOOLS = ["read", "grep", "find", "ls", "web_search"];

const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.6-terra";
const CURSOR_PROVIDER = "cursor";
const OPENROUTER_PROVIDER = "openrouter";
const FIRST_ACTIVITY_TIMEOUT_MS = 75_000;
const IDLE_TIMEOUT_MS = 35_000;
const HARD_TURN_TIMEOUT_MS = 180_000;
const require = createRequire(import.meta.url);

let modelRuntime;
let session;
let unsubscribe;
let activeRequestId;
let activeIdleTimeout;
let activeHardTimeout;
let activeTimedOut = false;
let activeAborted = false;
let emittedOutput = false;
let currentText = "";
let finalAssistant;

function formatLog(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function emit(message) {
  protocolWrite(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  emit({ id, ok: true, result });
}

function reject(id, error, code = "pi_error") {
  emit({ id, ok: false, error: error instanceof Error ? error.message : String(error), code });
}

function event(type, payload = {}) {
  emit({ event: type, ...payload });
}

function clearTurnTimers() {
  if (activeIdleTimeout) clearTimeout(activeIdleTimeout);
  if (activeHardTimeout) clearTimeout(activeHardTimeout);
  activeIdleTimeout = undefined;
  activeHardTimeout = undefined;
}

function abortTimedOutTurn(timeoutMs, phase) {
  if (activeRequestId === undefined || activeTimedOut) return;
  activeTimedOut = true;
  event("timeout", { timeoutMs, phase });
  void session?.abort();
}

function armIdleTimer(timeoutMs = IDLE_TIMEOUT_MS, phase = "idle") {
  if (activeRequestId === undefined || activeTimedOut) return;
  if (activeIdleTimeout) clearTimeout(activeIdleTimeout);
  activeIdleTimeout = setTimeout(() => abortTimedOutTurn(timeoutMs, phase), timeoutMs);
}

function markTurnActivity() {
  armIdleTimer(IDLE_TIMEOUT_MS, "idle");
}

function compact(value, limit = 4_000) {
  const text = formatLog(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function assistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function finalAssistantDiagnostic() {
  if (!finalAssistant) return "no finalized assistant message";
  const contentTypes = Array.isArray(finalAssistant.content)
    ? [...new Set(finalAssistant.content.map((block) => block?.type).filter(Boolean))].join(", ") || "none"
    : "none";
  const details = [
    `stop reason: ${finalAssistant.stopReason || "unknown"}`,
    `content: ${contentTypes}`,
    finalAssistant.errorMessage ? `provider error: ${finalAssistant.errorMessage}` : "",
  ].filter(Boolean);
  return details.join("; ");
}

function recoverFinalizedText() {
  if (currentText.trim()) return;
  const finalized = assistantText(finalAssistant);
  if (!finalized.trim()) return;
  currentText = finalized;
  emittedOutput = true;
  event("text_delta", { delta: finalized, recovered: true });
}

function subscribeToSession(nextSession) {
  unsubscribe?.();
  unsubscribe = nextSession.subscribe((update) => {
    switch (update.type) {
      case "agent_start":
        markTurnActivity();
        event("agent_start");
        break;
      case "turn_start":
        markTurnActivity();
        event("turn_start");
        break;
      case "message_update": {
        markTurnActivity();
        const delta = update.assistantMessageEvent;
        if (delta.type === "text_delta") {
          emittedOutput = true;
          currentText += delta.delta;
          event("text_delta", { delta: delta.delta });
        } else if (delta.type === "thinking_delta") {
          emittedOutput = true;
          event("thinking_delta", { delta: delta.delta });
        }
        break;
      }
      case "message_end":
        markTurnActivity();
        if (update.message?.role === "assistant") {
          finalAssistant = update.message;
        }
        break;
      case "tool_execution_start":
        markTurnActivity();
        emittedOutput = true;
        event("tool_start", {
          toolCallId: update.toolCallId,
          toolName: update.toolName,
          args: update.args,
        });
        break;
      case "tool_execution_update":
        markTurnActivity();
        event("tool_update", {
          toolCallId: update.toolCallId,
          toolName: update.toolName,
          partialResult: compact(update.partialResult),
        });
        break;
      case "tool_execution_end":
        markTurnActivity();
        event("tool_end", {
          toolCallId: update.toolCallId,
          toolName: update.toolName,
          isError: update.isError,
          result: compact(update.result),
        });
        break;
      case "auto_retry_start":
        markTurnActivity();
        event("retry", {
          attempt: update.attempt,
          maxAttempts: update.maxAttempts,
          delayMs: update.delayMs,
          error: update.errorMessage,
        });
        break;
      case "compaction_start":
        markTurnActivity();
        event("compaction_start", { reason: update.reason });
        break;
      case "agent_end":
        markTurnActivity();
        event("agent_cycle_end", { requestId: activeRequestId, willRetry: update.willRetry });
        break;
      default:
        break;
    }
  });
}

function authInstructions(provider) {
  if (provider === "xai") return "xAI subscription OAuth is not configured. Run Pi /login xai and choose Use a subscription.";
  if (provider === "openai-codex") return "ChatGPT OAuth is not configured. Run Pi /login openai-codex once.";
  if (provider === CURSOR_PROVIDER) {
    return "Cursor SDK API key is not configured. Set CURSOR_API_KEY or run Pi /login and choose Cursor.";
  }
  if (provider === "openrouter") {
    return "OpenRouter API key is not configured. Set OPENROUTER_API_KEY or run Pi /login openrouter.";
  }
  return `Pi authentication is not configured for ${provider}.`;
}

async function ensureRuntime() {
  if (!modelRuntime) {
    modelRuntime = await ModelRuntime.create({
      refreshOnCreate: false,
      allowModelNetwork: false,
      signal: AbortSignal.timeout(10_000),
    });
  }
  return modelRuntime;
}

async function loadCursorExtensionFactory() {
  const packageRoot = dirname(require.resolve("pi-cursor-sdk/package.json"));
  const { default: factory } = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);
  if (typeof factory !== "function") {
    throw new Error("pi-cursor-sdk did not export an extension factory");
  }
  return factory;
}

async function registerOpenRouterProvider(runtime) {
  let key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    try {
      const auth = JSON.parse(await readFile(join(process.env.HOME ?? "", ".pi/agent/auth.json"), "utf8"));
      key = auth?.openrouter?.key?.trim();
    } catch {
      /* auth.json optional */
    }
  }
  if (key) await runtime.setRuntimeApiKey(OPENROUTER_PROVIDER, key);
  // Bundled Pi catalog lags OpenRouter; refresh the provider model list at session start.
  await runtime.refresh({ allowNetwork: true, signal: AbortSignal.timeout(15_000) });
}

async function registerCursorProvider(runtime, resourceLoader) {
  const extensions = resourceLoader.getExtensions();
  for (const failure of extensions.errors) {
    logToStderr(`pi-cursor-sdk load error: ${failure.path}: ${failure.error}`);
  }
  for (const pending of extensions.runtime.pendingProviderRegistrations) {
    runtime.registerProvider(pending.name, pending.config);
  }
  extensions.runtime.pendingProviderRegistrations = [];
  for (const pending of extensions.runtime.pendingNativeProviderRegistrations) {
    runtime.registerNativeProvider(pending.provider);
  }
  extensions.runtime.pendingNativeProviderRegistrations = [];
  const key = process.env.CURSOR_API_KEY?.trim();
  if (key) await runtime.setRuntimeApiKey(CURSOR_PROVIDER, key);
  await runtime.refresh({ allowNetwork: false, signal: AbortSignal.timeout(10_000) });
}

async function requireAuth(runtime, provider) {
  const auth = await runtime.checkAuth(provider, { signal: AbortSignal.timeout(10_000) });
  if (!auth) {
    const error = new Error(authInstructions(provider));
    error.code = "auth_required";
    throw error;
  }
}

function openRouterCatalogId(modelId) {
  return String(modelId || "").replace(/:nitro$/i, "");
}

function wantsOpenRouterNitro(command, modelId) {
  return command.nitro === true || /:nitro$/i.test(String(modelId || ""));
}

async function startSession(command) {
  await closeSession();
  const provider = command.provider || DEFAULT_PROVIDER;
  const requestedModelId = command.model || DEFAULT_MODEL;
  const nitro = provider === OPENROUTER_PROVIDER && wantsOpenRouterNitro(command, requestedModelId);
  const modelId = provider === OPENROUTER_PROVIDER ? openRouterCatalogId(requestedModelId) : requestedModelId;
  const runtime = await ensureRuntime();
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 1 },
    compaction: { enabled: true },
  });
  const extensionFactories = [];
  if (provider === CURSOR_PROVIDER) {
    extensionFactories.push({
      name: "pi-cursor-sdk",
      factory: await loadCursorExtensionFactory(),
    });
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd: command.workspace,
    agentDir: command.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories,
    systemPrompt: [
      command.instructions,
      "You are the authoritative Pi lane in a live interview assistant.",
      "Lookup gate: if packed notes or screenshots already contain the needed detail or two named tactics, answer with no tools.",
      "Missing named tactics is the gate, not confidence. If you cannot already name two concrete tactics, checks, metrics, or implementation anchors — including theory, algorithms, LeetCode, APIs, or a named implementation — do one lookup round, then answer.",
      "Use read/grep/find/ls on the absolute repo roots in the packed repo map when the notes name a project but omit the needed file-level detail.",
      "Use web_search when packed notes do not already give those named tactics or a current public fact, including LeetCode and theory.",
      "Cap: one lookup round per turn, then answer. Never mention tools or that you searched.",
      "Spoken default: about 4–7 short sentences. Direct answer, mechanism, two named tactics, one tradeoff, then stop. STAR only for time/conflict/failure questions.",
      command.context ? `<experience_context>\n${command.context}\n</experience_context>` : "",
    ].filter(Boolean).join("\n\n"),
  });
  await resourceLoader.reload();
  if (provider === CURSOR_PROVIDER) {
    await registerCursorProvider(runtime, resourceLoader);
  } else if (provider === OPENROUTER_PROVIDER) {
    await registerOpenRouterProvider(runtime);
  }
  await requireAuth(runtime, provider);
  const registeredModel = runtime.getModel(provider, modelId);
  if (!registeredModel) throw new Error(`Pi model is unavailable: ${provider}/${modelId}`);
  // Pi still marks some Grok models as lacking reasoning_effort support.
  // xAI supports low/medium/high (and xhigh on 4.6) and defaults to high when
  // the field is omitted. Correct the stale catalogue metadata so the
  // requested thinking level is serialized into the API request.
  let model = provider === "xai" && (modelId === "grok-4.5" || modelId === "grok-4.6")
    ? {
        ...registeredModel,
        compat: {
          ...registeredModel.compat,
          supportsReasoningEffort: true,
        },
      }
    : registeredModel;
  const routedModelId = nitro ? `${modelId}:nitro` : modelId;
  const maxTokens = Number(command.maxTokens);
  if (nitro || (Number.isFinite(maxTokens) && maxTokens > 0)) {
    model = {
      ...model,
      id: routedModelId,
      ...(Number.isFinite(maxTokens) && maxTokens > 0
        ? { maxTokens: Math.floor(maxTokens) }
        : {}),
    };
  }

  const created = await createAgentSession({
    cwd: command.workspace,
    agentDir: command.agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: command.thinkingLevel || "low",
    tools: PI_TOOLS,
    customTools: [createWebSearchTool()],
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(command.workspace),
  });
  session = created.session;
  // Priority service tier is specific to the OpenAI Codex subscription route.
  if (provider === "openai-codex") {
    session.agent.onPayload = async (payload) => ({
      ...payload,
      service_tier: "priority",
    });
  }
  const previousOnPayload = session.agent.onPayload;
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    session.agent.onPayload = async (payload, modelArg) => {
      const next = typeof previousOnPayload === "function"
        ? await previousOnPayload(payload, modelArg)
        : payload;
      return { ...next, max_tokens: Math.floor(maxTokens) };
    };
  }
  subscribeToSession(session);
  event("session_ready", {
    sessionId: session.sessionId,
    provider,
    model: routedModelId,
    nitro,
    ...(provider === "openai-codex" ? { serviceTier: "priority" } : {}),
    tools: PI_TOOLS,
  });
  return { sessionId: session.sessionId, provider, model: routedModelId, nitro };
}

async function waitForTurnSlot() {
  const deadline = Date.now() + 5_000;
  while (activeRequestId !== undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runPrompt(command) {
  if (!session) throw new Error("Start the Pi session first");
  if (activeRequestId !== undefined) {
    event("turn_replaced", { previousRequestId: activeRequestId, requestId: command.id });
    await abortTurn();
    if (activeRequestId !== undefined) {
      throw new Error("Pi turn abort did not settle");
    }
  }
  activeRequestId = command.id;
  activeTimedOut = false;
  activeAborted = false;
  emittedOutput = false;
  currentText = "";
  finalAssistant = undefined;
  const images = await imagesFromPaths(command.imagePaths);
  armIdleTimer(FIRST_ACTIVITY_TIMEOUT_MS, "first_activity");
  activeHardTimeout = setTimeout(
    () => abortTimedOutTurn(HARD_TURN_TIMEOUT_MS, "hard_limit"),
    HARD_TURN_TIMEOUT_MS,
  );
  event("prompt_accepted", { requestId: command.id });
  try {
    await session.prompt(command.prompt || "Answer using the attached screenshot.", {
      images,
      expandPromptTemplates: false,
      source: "sdk",
    });
    if (activeAborted) {
      event("turn_aborted", { requestId: command.id });
      return { text: currentText, aborted: true };
    }
    if (activeTimedOut) throw new Error("Pi turn stopped after its activity deadline");
    recoverFinalizedText();
    if (!currentText.trim()) {
      if (finalAssistant?.stopReason === "error") {
        throw new Error(`Pi provider failed (${finalAssistantDiagnostic()})`);
      }
      event("empty_response_recovery", { diagnostic: finalAssistantDiagnostic() });
      finalAssistant = undefined;
      await session.prompt(
        "Your previous response ended without any visible answer. Return the final answer to the preceding user request now. Do not call tools and do not output reasoning.",
        { expandPromptTemplates: false, source: "sdk" },
      );
      if (activeAborted) {
        event("turn_aborted", { requestId: command.id });
        return { text: currentText, aborted: true };
      }
      if (activeTimedOut) throw new Error("Pi turn stopped after its activity deadline");
      recoverFinalizedText();
    }
    if (!currentText.trim()) {
      throw new Error(`Pi completed without a final answer after one recovery attempt (${finalAssistantDiagnostic()})`);
    }
    event("turn_complete", { requestId: command.id });
    return { text: currentText, emittedOutput };
  } catch (error) {
    if (activeAborted) {
      event("turn_aborted", { requestId: command.id });
      return { text: currentText, aborted: true };
    }
    throw error;
  } finally {
    clearTurnTimers();
    activeRequestId = undefined;
    activeAborted = false;
  }
}

async function abortTurn() {
  if (!session || activeRequestId === undefined) return { aborted: false };
  activeAborted = true;
  clearTurnTimers();
  await session.abort().catch(() => {});
  await waitForTurnSlot();
  return { aborted: true };
}

async function closeSession() {
  clearTurnTimers();
  if (session) {
    if (activeRequestId !== undefined) await session.abort().catch(() => {});
    unsubscribe?.();
    unsubscribe = undefined;
    session.dispose();
    session = undefined;
  }
  activeRequestId = undefined;
  return { closed: true };
}

async function dispatch(command) {
  switch (command.type) {
    case "start":
      reply(command.id, await startSession(command));
      break;
    case "prompt":
      runPrompt(command).then(
        (result) => reply(command.id, result),
        (error) => reject(command.id, error, error?.code || (activeTimedOut ? "timeout" : "prompt_failed")),
      );
      break;
    case "abort":
      reply(command.id, await abortTurn());
      break;
    case "close":
      reply(command.id, await closeSession());
      break;
    case "ping":
      reply(command.id, { ready: Boolean(session), active: activeRequestId !== undefined });
      break;
    default:
      reject(command.id, `Unknown Pi bridge command: ${command.type}`, "invalid_command");
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let command;
  try {
    command = JSON.parse(line);
  } catch (error) {
    reject(null, `Invalid bridge JSON: ${error.message}`, "invalid_json");
    continue;
  }
  Promise.resolve(dispatch(command)).catch((error) => reject(command.id, error, error?.code));
}

await closeSession();
