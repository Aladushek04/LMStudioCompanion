/**
 * The compaction decision: given the current history, cache coverage, and
 * token budget, decide which chunk cuts to summarize this turn. Lazy for
 * auto mode (only enough chunks to get back under the limit), exhaustive for
 * a forced /compress.
 */
import { CanonMessage, chunkEnds, maxAllowedCut, roundBoundaries } from "./view";

export interface CompactionPlan {
  /** Ascending cut indices; each is the exclusive end of one chunk. */
  cuts: number[];
  reason: "force" | "auto" | null;
}

export interface PlanInput {
  msgs: CanonMessage[];
  /** Per-message token counts aligned with msgs. */
  tokens: number[];
  /** Number of leading messages already covered by cached summaries. */
  coveredUpTo: number;
  /** Tokens currently occupied by the existing summary block (0 = none). */
  summaryTokens: number;
  /** Estimated tokens one new chunk summary will occupy. */
  estSummaryTokensPerChunk: number;
  /** Auto-compaction budget; undefined disables auto. */
  limit: number | undefined;
  /**
   * Hysteresis target: once triggered, compact until below this (defaults
   * to limit). A floor well under the limit gives long agentic turns real
   * intra-turn headroom instead of re-triggering every few turns.
   */
  floor?: number;
  autoCompact: boolean;
  force: boolean;
  keepRecentTokens: number;
  chunkTokens: number;
  /** Max chunks summarized in one pass; 0/undefined = no cap (auto). */
  maxChunks?: number;
}

const NO_PLAN: CompactionPlan = { cuts: [], reason: null };

export function planCompaction(input: PlanInput): CompactionPlan {
  const boundaries = roundBoundaries(input.msgs);
  const maxCut = maxAllowedCut(boundaries, input.tokens, input.keepRecentTokens);
  let cuts = chunkEnds(
    boundaries,
    input.tokens,
    input.coveredUpTo,
    input.chunkTokens,
    maxCut,
  );
  if (input.maxChunks !== undefined && input.maxChunks > 0) {
    cuts = cuts.slice(0, input.maxChunks);
  }
  if (cuts.length === 0) return { ...NO_PLAN };
  if (input.force) return { cuts, reason: "force" };
  if (!input.autoCompact || input.limit === undefined) return { ...NO_PLAN };

  const sumRange = (from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += input.tokens[i];
    return sum;
  };
  let viewTokens =
    input.summaryTokens + sumRange(input.coveredUpTo, input.msgs.length);
  if (viewTokens <= input.limit) return { ...NO_PLAN };

  const target =
    input.floor !== undefined ? Math.min(input.floor, input.limit) : input.limit;
  const taken: number[] = [];
  let from = input.coveredUpTo;
  for (const cut of cuts) {
    viewTokens = viewTokens - sumRange(from, cut) + input.estSummaryTokensPerChunk;
    taken.push(cut);
    from = cut;
    if (viewTokens < target) break;
  }
  return { cuts: taken, reason: "auto" };
}
