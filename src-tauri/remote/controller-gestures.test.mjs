import test from "node:test";
import assert from "node:assert/strict";
import {
  clampDelta,
  coalesceDelta,
  pointerScrollDelta,
  pointerDistance,
  isScrollArmed,
  isTapGesture,
  momentumStep,
  shouldCancelMomentum,
  shouldDeferSend,
  controllerSnapshot,
  parseClientRole,
} from "./controller-gestures.mjs";

test("a short still press is a tap, movement arms scroll", () => {
  assert.equal(pointerDistance(10, 10, 14, 12), Math.hypot(4, 2));
  assert.equal(isTapGesture({ distance: 4, durationMs: 120 }), true);
  assert.equal(isTapGesture({ distance: 4, durationMs: 800 }), false);
  assert.equal(isTapGesture({ distance: 30, durationMs: 80 }), false);
  assert.equal(isScrollArmed(4), false);
  assert.equal(isScrollArmed(13), true);
});

test("dragging upward increases scrollTop to reveal later text", () => {
  assert.equal(pointerScrollDelta(120, 80), 40);
  assert.equal(pointerScrollDelta(80, 120), -40);
});

test("clamps malformed and extreme deltas", () => {
  assert.equal(clampDelta(Number.NaN), 0);
  assert.equal(clampDelta(2_000), 800);
  assert.equal(clampDelta(-2_000), -800);
});

test("coalesces frame deltas instead of queueing stale movement", () => {
  assert.equal(coalesceDelta(12, 8), 20);
  assert.equal(coalesceDelta(790, 80), 800);
});

test("momentum decays and a new touch cancels it", () => {
  const slowed = momentumStep(20);
  assert.ok(slowed > 0 && slowed < 20);
  assert.equal(momentumStep(0.2), 0);
  assert.equal(shouldCancelMomentum(1, 2), true);
  assert.equal(shouldCancelMomentum(1, 1), false);
});

test("defers sends when the websocket is backpressured", () => {
  assert.equal(shouldDeferSend(20_000), true);
  assert.equal(shouldDeferSend(10), false);
});

test("controller snapshots omit private session content", () => {
  const filtered = controllerSnapshot({
    lifecycle: "active",
    started: true,
    mode: "webapp",
    busy: true,
    canSend: true,
    messages: [{ role: "assistant", content: "secret answer" }],
    liveTranscript: { source: "Speaker", text: "private" },
    piSelection: { key: "openai-codex/gpt-5.6-terra" },
    piModels: [{ key: "openai-codex/gpt-5.6-terra" }],
  }, { displays: 1, controllers: 2 });
  assert.deepEqual(filtered, {
    lifecycle: "active",
    started: true,
    mode: "webapp",
    busy: true,
    canSend: true,
    connectedDisplays: 1,
    connectedControllers: 2,
  });
  assert.equal("messages" in filtered, false);
  assert.equal("liveTranscript" in filtered, false);
  assert.equal("piSelection" in filtered, false);
});

test("unknown roles default to display", () => {
  assert.equal(parseClientRole("controller"), "controller");
  assert.equal(parseClientRole("display"), "display");
  assert.equal(parseClientRole("admin"), "display");
});
