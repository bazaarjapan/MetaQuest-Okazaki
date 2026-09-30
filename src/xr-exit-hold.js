export const exitHoldDurationMs = 1500;

export function createExitHold() {
  return cancelExitHold({ durationMs: exitHoldDurationMs });
}

// An interruption must not turn a button which remains held into a new action.
// Require a fresh, valid release before accepting the next press.
export function cancelExitHold(state) {
  state.armed = false;
  state.startedAt = null;
  state.lastNow = null;
  state.fired = false;
  state.progress = 0;
  return state;
}

function result(state, toggleGuide = false, exit = false) {
  return {
    toggleGuide,
    exit,
    progress: state.progress,
    holding: state.startedAt !== null,
  };
}

// now is a monotonic timestamp in milliseconds, e.g. the XR animation timestamp.
// No wall-clock timers are used; the caller also cancels on session interruption.
export function updateExitHold(state, { pressed, available = true, now } = {}) {
  if (
    !available ||
    typeof pressed !== "boolean" ||
    !Number.isFinite(now) ||
    (state.lastNow !== null && now < state.lastNow)
  ) {
    cancelExitHold(state);
    return result(state);
  }
  state.lastNow = now;

  if (!pressed) {
    const wasHolding = state.startedAt !== null;
    const elapsed = wasHolding ? now - state.startedAt : 0;
    const exit = wasHolding && !state.fired && elapsed >= state.durationMs;
    const toggleGuide = wasHolding && !state.fired && !exit;
    state.armed = true;
    state.startedAt = null;
    state.fired = false;
    state.progress = 0;
    return result(state, toggleGuide, exit);
  }

  if (!state.armed) return result(state);
  if (state.startedAt === null) state.startedAt = now;
  const elapsed = now - state.startedAt;
  state.progress = Math.max(0, Math.min(1, elapsed / state.durationMs));
  const exit = !state.fired && elapsed >= state.durationMs;
  if (exit) state.fired = true;
  return result(state, false, exit);
}
