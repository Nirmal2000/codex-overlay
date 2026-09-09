import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(ROOT, "index.mjs");
const ENV_CANDIDATES = [
  join(ROOT, "../src-tauri/.env"),
  join(ROOT, "../.env"),
];

function redact(text) {
  return String(text)
    .replace(/sk-or-v1-[A-Za-z0-9]+/g, "sk-or-v1_[redacted]")
    .replace(/crsr_[A-Za-z0-9]+/g, "crsr_[redacted]");
}

function fail(message) {
  process.stderr.write(`${redact(message)}\n`);
  process.exit(1);
}

async function loadOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  for (const path of ENV_CANDIDATES) {
    try {
      const contents = await readFile(path, "utf8");
      for (const line of contents.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#") || !trimmed.startsWith("OPENROUTER_API_KEY=")) continue;
        const value = trimmed.slice("OPENROUTER_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    } catch {
      /* next candidate */
    }
  }
  try {
    const auth = JSON.parse(await readFile(join(process.env.HOME, ".pi/agent/auth.json"), "utf8"));
    const key = auth?.openrouter?.key;
    if (typeof key === "string" && key.trim()) return key.trim();
  } catch {
    /* auth.json optional */
  }
  return undefined;
}

class BridgeClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.events = [];
    this.stderr = [];
    this.reader = createInterface({ input: child.stdout });
    this.reader.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.event) {
        this.events.push(message);
        return;
      }
      const { resolve, reject } = this.pending.get(message.id) ?? {};
      this.pending.delete(message.id);
      if (!resolve) return;
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error || "bridge request failed"));
    });
    child.stderr.on("data", (chunk) => {
      this.stderr.push(String(chunk));
    });
  }

  send(command, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  close() {
    this.child.kill("SIGTERM");
  }
}

function assertContains(text, expected, label) {
  if (!String(text).includes(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)} in ${JSON.stringify(text)}`);
  }
}

const key = await loadOpenRouterKey();
if (!key) fail("OPENROUTER_API_KEY is missing; save it in src-tauri/.env, ~/.pi/agent/auth.json, or the environment.");

const workspace = await mkdtemp(join(tmpdir(), "codex-overlay-pi-openrouter-"));
const child = spawn(process.execPath, [BRIDGE], {
  env: { ...process.env, OPENROUTER_API_KEY: key },
  stdio: ["pipe", "pipe", "pipe"],
});
const client = new BridgeClient(child);

try {
  const started = await client.send({
    type: "start",
    workspace,
    agentDir: join(process.env.HOME, ".pi/agent"),
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    thinkingLevel: "low",
    instructions: "Reply with only the exact token requested. Do not call tools. Do not explain.",
    context: "",
  }, 60_000);
  if (started.provider !== "openrouter" || started.model !== "z-ai/glm-5.3-flash") {
    fail(`unexpected session: ${JSON.stringify(started)}`);
  }

  const textTurn = await client.send({
    type: "prompt",
    prompt: "Reply exactly OPENROUTER_GLM_OK and nothing else.",
  }, 180_000);
  assertContains(textTurn.text, "OPENROUTER_GLM_OK", "text turn");

  process.stderr.write("pi-openrouter live turn passed\n");
} catch (error) {
  const stderr = client.stderr.join("").slice(-4_000);
  fail(`${error instanceof Error ? error.message : error}${stderr ? `\n--- pi-bridge stderr ---\n${stderr}` : ""}`);
} finally {
  client.close();
}
