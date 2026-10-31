import type { PromptVariant } from "./summarizer";

/**
 * Small-context clamping: on a small-context model, the configured
 * verbatim/chunk/reserve/summary sizes can each exceed what the window can
 * hold at all — e.g. keepRecentTokens 6000 on a 4k window leaves no room
 * for compaction to ever cut, right where it's needed most. Each field is
 * capped to max(floor, ctx * fraction) of the real context length; the
 * effective value only ever reduces a configured one, never raises it.
 */
export interface SizeConfig {
  contextLength: number | undefined;
  /**
   * Tokens every prompt carries before a single message: the tool
   * definitions LM Studio attaches (a tools provider's schemas alone can be
   * ~5k). Sizes are clamped against what is left, not the raw window — with
   * ten tool schemas on a 16k model the raw-window fractions produced a
   * 16,557-token request for a 16,384-token context.
   */
  fixedOverheadTokens?: number;
  keepRecentTokens: number;
  chunkTokens: number;
  reservedOutputTokens: number;
  summarizerMaxTokens: number;
  /** Cap on one tool result; 0 = unlimited and is never clamped. */
  maxToolResultTokens?: number;
  /** Tool rounds between mid-task budget checks; 0 = unlimited, never clamped. */
  roundsPerPass?: number;
}

export interface EffectiveSizes {
  keepRecentTokens: number;
  chunkTokens: number;
  reservedOutputTokens: number;
  summarizerMaxTokens: number;
  maxToolResultTokens: number;
  roundsPerPass: number;
  /**
   * Tokens one pass of tool rounds may add before the next budget check —
   * every round's reply plus a capped tool result. The fit check reserves
   * this on top of the reply reserve, so a pass cannot push a prompt that
   * "fit" over the window (the live failure: 11,067 + 5,300 of schemas fit;
   * two reads and an apply later the request was 17,554 of 16,384).
   */
  passAllowanceTokens: number;
  /** Safety margin in the floor arithmetic: 2,000, or 10% of a small usable window. */
  marginTokens: number;
  /** Largest consolidated summary: 3,000, twice a chunk summary, or 15% of a small window. */
  mergeMaxTokens: number;
  /** Window left after the fixed overhead; undefined when the context length is unknown. */
  usableContextTokens: number | undefined;
  /** Names of fields that were reduced, for the one-time warning. */
  clamped: string[];
}

/** A round costs a reply (~512) plus a tool result (its cap, or 2,048 when unlimited). */
function passAllowance(rounds: number, toolCap: number): number {
  return Math.max(1, rounds) * ((toolCap > 0 ? toolCap : 2048) + 512);
}

export function effectiveSizes(cfg: SizeConfig): EffectiveSizes {
  const overhead = Math.max(0, cfg.fixedOverheadTokens ?? 0);
  const ctx =
    cfg.contextLength === undefined || cfg.contextLength <= 0
      ? undefined
      : Math.max(0, cfg.contextLength - overhead);
  if (ctx === undefined) {
    return {
      keepRecentTokens: cfg.keepRecentTokens,
      chunkTokens: cfg.chunkTokens,
      reservedOutputTokens: cfg.reservedOutputTokens,
      summarizerMaxTokens: cfg.summarizerMaxTokens,
      maxToolResultTokens: cfg.maxToolResultTokens ?? 0,
      roundsPerPass: cfg.roundsPerPass ?? 0,
      passAllowanceTokens: passAllowance(
        cfg.roundsPerPass ?? 0,
        cfg.maxToolResultTokens ?? 0,
      ),
      marginTokens: 2000,
      mergeMaxTokens: Math.min(3000, 2 * cfg.summarizerMaxTokens),
      usableContextTokens: undefined,
      clamped: [],
    };
  }
  const clamped: string[] = [];
  const clamp = (
    name: string,
    configured: number,
    floor: number,
    fraction: number,
  ): number => {
    const cap = Math.max(floor, Math.floor(ctx * fraction));
    if (configured > cap) {
      clamped.push(name);
      return cap;
    }
    return configured;
  };
  const keepRecentTokens = clamp(
    "keepRecentTokens",
    cfg.keepRecentTokens,
    512,
    0.25,
  );
  const chunkTokens = clamp("chunkTokens", cfg.chunkTokens, 1024, 0.3);
  const reservedOutputTokens = clamp(
    "reservedOutputTokens",
    cfg.reservedOutputTokens,
    256,
    0.25,
  );
  const summarizerMaxTokens = clamp(
    "summarizerMaxTokens",
    cfg.summarizerMaxTokens,
    200,
    0.15,
  );
  // One tool result may not eat more than 15% of the usable window: a turn
  // grows by whole tool results between budget checks, and the floor only
  // leaves a few thousand tokens of room on a small window.
  const configuredToolCap = cfg.maxToolResultTokens ?? 0;
  const maxToolResultTokens =
    configuredToolCap > 0
      ? clamp("maxToolResultTokens", configuredToolCap, 512, 0.15)
      : configuredToolCap;
  // Budget checks happen between passes; on a small window a pass must be
  // short enough that its rounds cannot outgrow the room the floor leaves.
  // One round per 6k of usable window, never fewer than one — on a 16k
  // model with a full tools provider that is a check before every round.
  const configuredRounds = cfg.roundsPerPass ?? 0;
  let roundsPerPass = configuredRounds;
  if (configuredRounds > 0) {
    const cap = Math.max(1, Math.floor(ctx / 6000));
    if (configuredRounds > cap) {
      clamped.push("roundsPerPass");
      roundsPerPass = cap;
    }
  }
  // Never reserve more than a quarter of the window for a pass: on a large
  // window a pass rarely uses every round at the full result cap, and the
  // reserve would otherwise eat the room the trigger is meant to leave.
  const passAllowanceTokens = Math.min(
    passAllowance(roundsPerPass, maxToolResultTokens),
    Math.max(1024, Math.floor(ctx * 0.25)),
  );
  const marginTokens = Math.min(2000, Math.max(512, Math.floor(ctx * 0.1)));
  const mergeMaxTokens = Math.min(
    3000,
    2 * summarizerMaxTokens,
    Math.max(600, Math.floor(ctx * 0.15)),
  );
  return {
    keepRecentTokens,
    chunkTokens,
    reservedOutputTokens,
    summarizerMaxTokens,
    maxToolResultTokens,
    roundsPerPass,
    passAllowanceTokens,
    marginTokens,
    mergeMaxTokens,
    usableContextTokens: ctx,
    clamped,
  };
}

/**
 * Which summarizer system-prompt variant to use this turn. Forced modes
 * ("full"/"compact") always win; "auto" always resolves to "full" — bench
 * 2026-08-24: full beat compact on recall at 3B and 18B; auto stays full —
 * compact remains the rescue prompt and a manual option.
 */
export function pickPromptVariant(
  mode: "auto" | "full" | "compact",
): PromptVariant {
  if (mode !== "auto") return mode;
  return "full";
}
