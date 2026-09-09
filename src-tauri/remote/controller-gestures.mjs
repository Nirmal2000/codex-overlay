export const MAX_SCROLL_DELTA = 800;
export const MOMENTUM_FRICTION = 0.92;
export const MOMENTUM_STOP = 0.45;
export const BACKPRESSURE_BYTES = 16_384;
export const TAP_MAX_DISTANCE = 12;
export const TAP_MAX_DURATION_MS = 400;

export function clampDelta(deltaY, max = MAX_SCROLL_DELTA) {
  const value = Number(deltaY);
  if (!Number.isFinite(value)) return 0;
  return Math.max(-max, Math.min(max, value));
}

export function coalesceDelta(pending, next) {
  return clampDelta((Number(pending) || 0) + (Number(next) || 0));
}

export function pointerDistance(startX, startY, endX, endY) {
  const dx = (Number(endX) || 0) - (Number(startX) || 0);
  const dy = (Number(endY) || 0) - (Number(startY) || 0);
  return Math.hypot(dx, dy);
}

export function isScrollArmed(distance, threshold = TAP_MAX_DISTANCE) {
  return (Number(distance) || 0) > threshold;
}

export function isTapGesture({ distance, durationMs, maxDistance = TAP_MAX_DISTANCE, maxDurationMs = TAP_MAX_DURATION_MS }) {
  return (Number(distance) || 0) <= maxDistance && (Number(durationMs) || 0) <= maxDurationMs;
}

export function pointerScrollDelta(previousY, currentY) {
  return clampDelta((Number(previousY) || 0) - (Number(currentY) || 0));
}

export function momentumStep(velocity, friction = MOMENTUM_FRICTION) {
  const next = (Number(velocity) || 0) * friction;
  return Math.abs(next) < MOMENTUM_STOP ? 0 : next;
}

export function shouldCancelMomentum(activePointerId, incomingPointerId) {
  return incomingPointerId != null && incomingPointerId !== activePointerId;
}

export function shouldDeferSend(bufferedAmount, limit = BACKPRESSURE_BYTES) {
  return (Number(bufferedAmount) || 0) > limit;
}

export function controllerSnapshot(payload, counts = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  return {
    lifecycle: source.lifecycle || (source.started ? "active" : "idle"),
    started: Boolean(source.started),
    mode: source.mode ?? null,
    busy: Boolean(source.busy),
    canSend: Boolean(source.canSend),
    connectedDisplays: Number(counts.displays) || 0,
    connectedControllers: Number(counts.controllers) || 0,
  };
}

export function parseClientRole(value) {
  return value === "controller" ? "controller" : "display";
}
