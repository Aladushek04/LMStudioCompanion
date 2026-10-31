/**
 * Per-model process state: a token counter, one-time warning keys already
 * shown, and small memoized fields — scoped by model identifier so one
 * chat/model can never leak counts or warnings into another's. Bounded to
 * MAX_STATES entries (evicting the least-recently-used) so a long-lived
 * session that cycles through many models doesn't grow this map forever.
 */
import { TokenCounter } from "./tokens";

export interface ModelState {
  counter: TokenCounter;
  /** Keys of one-time warnings already shown for this model. */
  warned: Set<string>;
  /** Consolidation merges burned out in reasoning; stop attempting them this session. */
  mergeDisabled?: boolean;
  /**
   * Whether this model's chat template accepts a system-role message
   * ("system") or must have it folded into a user turn instead
   * ("foldSystem" — stock Gemma, some Mistral variants). Resolved once per
   * model by resolveSystemStrategy() in handler.ts and memoized here so
   * later turns skip the probe; undefined means not yet resolved.
   */
  systemStrategy?: "system" | "foldSystem";
  /** Tool-definition cost measured on the most recent reply (for /usage). */
  lastToolSchemaTokens?: number;
}

const MAX_STATES = 4;

const states = new Map<string, ModelState>();

/**
 * Returns the state for identifier, creating one via makeCounter if absent.
 * Map iteration order doubles as recency order: an access re-inserts the
 * key (moving it to the most-recently-used end), and growing past
 * MAX_STATES evicts the first (least-recently-used) key.
 */
export function getModelState(
  identifier: string,
  makeCounter: () => TokenCounter,
): ModelState {
  const existing = states.get(identifier);
  if (existing) {
    states.delete(identifier);
    states.set(identifier, existing);
    return existing;
  }
  const state: ModelState = { counter: makeCounter(), warned: new Set() };
  states.set(identifier, state);
  if (states.size > MAX_STATES) {
    const oldest: string | undefined = states.keys().next().value;
    if (oldest !== undefined) states.delete(oldest);
  }
  return state;
}

/** Test-only: clears tracked state so test cases can't leak into each other. */
export function resetModelStates(): void {
  states.clear();
}

/** Minimal controller surface warnOnce needs — no SDK import required. */
export interface WarnCtl {
  createStatus(state: { status: "error" | "done"; text: string }): unknown;
}

/** Shows text via ctl.createStatus at most once per (state, key) pair. */
export function warnOnce(
  ctl: WarnCtl,
  state: ModelState,
  key: string,
  text: string,
  status: "error" | "done" = "error",
): void {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  ctl.createStatus({ status, text });
}
