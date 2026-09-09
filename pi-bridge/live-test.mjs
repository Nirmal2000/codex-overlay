import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(ROOT, "index.mjs");
const ENV_CANDIDATES = [
  join(ROOT, "../src-tauri/.env"),
  join(ROOT, "../.env"),
];

function redact(text) {
  return String(text).replace(/crsr_[A-Za-z0-9]+/g, "crsr_[redacted]");
}

function fail(message) {
  process.stderr.write(`${redact(message)}\n`);
  process.exit(1);
}

async function loadCursorKey() {
  if (process.env.CURSOR_API_KEY?.trim()) return process.env.CURSOR_API_KEY.trim();
  for (const path of ENV_CANDIDATES) {
    try {
      const contents = await readFile(path, "utf8");
      for (const line of contents.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#") || !trimmed.startsWith("CURSOR_API_KEY=")) continue;
        const value = trimmed.slice("CURSOR_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    } catch {
      /* next candidate */
    }
  }
  return undefined;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([length, crcInput, crc]);
}

function solidPng(r, g, b, size = 48) {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

class BridgeClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.stderr = [];
    this.lines = createInterface({ input: child.stdout });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.stderr.push(chunk));
    this.reader = this.read();
  }

  async read() {
    for await (const line of this.lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id != null && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error || "Pi bridge request failed"));
      } else if (message.event) {
        this.events.push(message);
      }
    }
  }

  send(command, timeoutMs) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${command.type} after ${timeoutMs}ms`));
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
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async close() {
    try {
      await this.send({ type: "close" }, 5_000);
    } catch {
      /* still kill */
    }
    this.child.kill();
    await this.reader.catch(() => {});
  }
}

function assertContains(text, expected, label) {
  if (!String(text).includes(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)} in ${JSON.stringify(text)}`);
  }
}

function assertNotContains(text, unexpected, label) {
  if (String(text).includes(unexpected)) {
    fail(`${label}: did not expect ${JSON.stringify(unexpected)} in ${JSON.stringify(text)}`);
  }
}

const key = await loadCursorKey();
if (!key) fail("CURSOR_API_KEY is missing; save it in src-tauri/.env or the environment.");

const workspace = await mkdtemp(join(tmpdir(), "codex-overlay-pi-cursor-"));
const alphaPath = join(workspace, "alpha.png");
const betaPath = join(workspace, "beta.png");
const gammaPath = join(workspace, "gamma.png");
await writeFile(alphaPath, solidPng(255, 0, 0));
await writeFile(betaPath, solidPng(0, 80, 255));
await writeFile(gammaPath, solidPng(0, 180, 0));

const child = spawn(process.execPath, [BRIDGE], {
  env: { ...process.env, CURSOR_API_KEY: key },
  stdio: ["pipe", "pipe", "pipe"],
});
const client = new BridgeClient(child);
const startedAt = Date.now();

try {
  const started = await client.send({
    type: "start",
    workspace,
    agentDir: join(process.env.HOME, ".pi/agent"),
    provider: "cursor",
    model: "gpt-5.6-terra@272k:fast",
    thinkingLevel: "low",
    instructions: "Reply with only the exact token requested. Do not call tools. Do not explain.",
    context: "",
  }, 90_000);
  if (started.provider !== "cursor" || started.model !== "gpt-5.6-terra@272k:fast") {
    fail(`unexpected session: ${JSON.stringify(started)}`);
  }
  const ready = client.events.find((event) => event.event === "session_ready");
  if (ready?.serviceTier) fail(`Cursor session should not use Codex priority: ${JSON.stringify(ready)}`);
  process.stderr.write(`session ready in ${Date.now() - startedAt}ms\n`);

  const textTurn = await client.send({
    type: "prompt",
    prompt: "Reply exactly CURSOR_TERRA_FAST_OK and nothing else.",
  }, 180_000);
  assertContains(textTurn.text, "CURSOR_TERRA_FAST_OK", "text turn");

  const multiImageTurn = await client.send({
    type: "prompt",
    prompt: "Two images are attached. The first is solid red and the second is solid blue. Reply exactly ALPHA,BETA and nothing else.",
    imagePaths: [alphaPath, betaPath],
  }, 180_000);
  assertContains(multiImageTurn.text, "ALPHA", "multi-image first label");
  assertContains(multiImageTurn.text, "BETA", "multi-image second label");

  const laterImageTurn = await client.send({
    type: "prompt",
    prompt: "This image is a solid color. If it is red reply ALPHA. If it is blue reply BETA. If it is green reply GAMMA. Reply with that token only.",
    imagePaths: [gammaPath],
  }, 180_000);
  assertContains(laterImageTurn.text, "GAMMA", "later-turn image");
  assertNotContains(laterImageTurn.text, "ALPHA,BETA", "later-turn should not reuse the previous pair");

  const twoImageFollowUp = await client.send({
    type: "prompt",
    prompt: "Two images are attached. The first is solid red and the second is solid green. Reply exactly ALPHA,GAMMA and nothing else.",
    imagePaths: [alphaPath, gammaPath],
  }, 180_000);
  assertContains(twoImageFollowUp.text, "ALPHA", "follow-up first label");
  assertContains(twoImageFollowUp.text, "GAMMA", "follow-up second label");

  process.stderr.write("pi-cursor live turns passed\n");
} catch (error) {
  const stderr = client.stderr.join("").slice(-4_000);
  fail(`${error instanceof Error ? error.message : error}${stderr ? `\n--- pi-bridge stderr ---\n${stderr}` : ""}`);
} finally {
  await client.close();
}
