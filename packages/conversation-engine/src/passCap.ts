/**
 * Pass capping for the tool loop without the SDK's `maxPredictionRounds`.
 *
 * `act({ maxPredictionRounds: N })` runs its Nth round with tools DISABLED so
 * the model is forced to answer. A model still mid-task then writes its tool
 * call as plain text in its native syntax (`<tool_call><function=...>`),
 * which streams into the chat as content and is never executed; the next
 * pass repeats the call for real. Every capped pass paid that wasted,
 * visible round.
 *
 * Instead, the handler passes no round limit and ends a pass by aborting
 * act()'s signal at the end of the last allowed round — after that round's
 * assistant message and tool results were emitted — so the SDK's loop stops
 * before starting another prediction. A pass is also ended early when the
 * grown history would no longer fit the next request, so mid-task
 * compaction can run before the engine rejects the prompt.
 *
 * Pure: no SDK imports, testable with plain AbortControllers.
 */

export interface PassCapOptions {
  /** Maximum prediction rounds per pass; undefined or <= 0 = unlimited. */
  maxRounds?: number;
  /** The caller's own abort signal (user Stop); mirrored into `signal`. */
  parentSignal: AbortSignal;
  /**
   * Optional fit check: given the number of completed rounds, return true
   * when the next round's request would no longer fit the window. Called at
   * the end of every round that made tool calls.
   */
  wouldOverflow?: (roundsCompleted: number) => boolean;
}

export type PassEndReason = "rounds" | "fit";

export interface PassCap {
  /** Signal to hand to act(): aborts on user Stop or when the pass is capped. */
  signal: AbortSignal;
  /** Call from onRoundEnd(roundIndex); decides whether to end the pass here. */
  onRoundEnd(roundIndex: number): void;
  /** Why the pass was capped, if it was; undefined when act() ended on its own or by the user. */
  reason(): PassEndReason | undefined;
  /** True when act() rejected because of this cap rather than the user. */
  isCapAbort(): boolean;
}

export class PassCapAbort extends Error {
  constructor(public readonly reason: PassEndReason) {
    super(`context-compressor pass ended (${reason})`);
    this.name = "PassCapAbort";
  }
}

export interface RoundFitInput {
  /** Exact token count of the prompt the pass started from (rendered view). */
  startTokens: number;
  /** Tool definitions the engine attaches to every request. */
  toolSchemaTokens: number;
  /** Estimated tokens of everything the pass has generated so far (assistant text incl. reasoning, tool calls, tool results). */
  grownTokens: number;
  /** Room to leave for the next reply. */
  reservedOutputTokens: number;
  contextLength: number;
}

/**
 * Cushion on the estimated in-pass growth: the estimate is a char-class
 * approximation and an early pass end costs one cheap budget check, while
 * an engine 400 kills the turn.
 */
export const GROWTH_CUSHION = 1.1;

/**
 * Whether the next round's request — the prompt the pass started from plus
 * everything generated since, plus the tool definitions — still leaves the
 * reply reserve inside the window. The between-pass fit check reserves a
 * static allowance per round; this is the dynamic check against what a
 * reasoning-heavy model actually produced (thousands of tokens of reasoning
 * per round stay in the history within a pass).
 */
export function nextRoundFits(input: RoundFitInput): boolean {
  const next =
    input.startTokens +
    input.toolSchemaTokens +
    Math.ceil(input.grownTokens * GROWTH_CUSHION);
  return next + input.reservedOutputTokens <= input.contextLength;
}

export function createPassCap(opts: PassCapOptions): PassCap {
  const controller = new AbortController();
  let reason: PassEndReason | undefined;
  const mirror = () => {
    if (!controller.signal.aborted) controller.abort(opts.parentSignal.reason);
  };
  if (opts.parentSignal.aborted) mirror();
  else opts.parentSignal.addEventListener("abort", mirror, { once: true });
  const maxRounds =
    opts.maxRounds !== undefined && opts.maxRounds > 0 ? opts.maxRounds : undefined;
  const end = (why: PassEndReason) => {
    if (reason !== undefined || controller.signal.aborted) return;
    reason = why;
    controller.abort(new PassCapAbort(why));
  };
  return {
    signal: controller.signal,
    onRoundEnd(roundIndex) {
      if (opts.parentSignal.aborted) return;
      const completed = roundIndex + 1;
      if (maxRounds !== undefined && completed >= maxRounds) {
        end("rounds");
        return;
      }
      if (opts.wouldOverflow?.(completed) === true) end("fit");
    },
    reason: () => reason,
    isCapAbort: () => reason !== undefined && !opts.parentSignal.aborted,
  };
}
