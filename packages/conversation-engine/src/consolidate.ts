/**
 * Rolling summary consolidation (pragmatic L1): when the assembled summary
 * block outgrows its budget, the oldest chunk summaries are merged into one
 * consolidated summary while the newest stay verbatim. Bounds summary mass
 * so the compact-to-floor target stays reachable at any conversation length.
 */

export interface ConsolidationPick {
  /** Oldest summaries to merge into one (chronological order). */
  merge: string[];
  /** Newest summaries kept verbatim (chronological order). */
  keep: string[];
}

export function pickConsolidation(
  summaries: string[],
  tokenCounts: number[],
  budgetTokens: number,
  keepNewest: number,
  mergeMaxTokens: number,
): ConsolidationPick | null {
  if (budgetTokens <= 0) return null;
  const total = tokenCounts.reduce((a, b) => a + b, 0);
  if (total <= budgetTokens) return null;
  const mergeCount = summaries.length - keepNewest;
  if (mergeCount < 2) return null;
  const keptTokens = tokenCounts
    .slice(mergeCount)
    .reduce((a, b) => a + b, 0);
  // No-gain guard: consolidation must actually shrink the block by a real
  // margin, or repeated re-folds would thrash (and compound drift).
  const projected = mergeMaxTokens + keptTokens;
  if (total - projected < mergeMaxTokens) return null;
  return {
    merge: summaries.slice(0, mergeCount),
    keep: summaries.slice(mergeCount),
  };
}

export interface EffectiveBudget {
  budget: number;
  keepNewest: number;
  floorReachable: boolean;
}

export function effectiveSummaryBudget(opts: {
  configuredBudget: number;
  /** Compact-to floor in tokens; undefined when context length unknown. */
  floorTokens?: number;
  keepRecentTokens: number;
  systemPromptTokens: number;
  summarizerMaxTokens: number;
  mergeMaxTokens: number;
  keepNewest: number;
  /** Safety margin under the floor; 2,000 unless a small window asks for less. */
  marginTokens?: number;
}): EffectiveBudget {
  const lowerClamp = opts.mergeMaxTokens + opts.summarizerMaxTokens;
  if (opts.floorTokens === undefined) {
    return {
      budget: opts.configuredBudget,
      keepNewest: opts.keepNewest,
      floorReachable: true,
    };
  }
  const margin = opts.marginTokens ?? 2000;
  const available =
    opts.floorTokens - opts.keepRecentTokens - opts.systemPromptTokens - margin;
  if (available < lowerClamp) {
    // The floor cannot hold even a minimal summary block: keep a working
    // budget (never negative) and report the floor as unreachable so the
    // handler can clamp and warn.
    return { budget: lowerClamp, keepNewest: 1, floorReachable: false };
  }
  return {
    budget: Math.min(opts.configuredBudget, available),
    keepNewest: opts.keepNewest,
    floorReachable: true,
  };
}
