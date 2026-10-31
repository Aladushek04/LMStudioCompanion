import { describe, expect, test } from "vitest";
import { effectiveSummaryBudget, pickConsolidation } from "../src/consolidate";

// 8 summaries of 1500 tokens each = 12000 total
const summaries = Array.from({ length: 8 }, (_, i) => `summary-${i}`);
const counts = new Array(8).fill(1500);

describe("pickConsolidation", () => {
  test("null while under budget", () => {
    expect(pickConsolidation(summaries, counts, 12_000, 4, 3000)).toBeNull();
  });

  test("merges the oldest, keeps the newest verbatim", () => {
    const pick = pickConsolidation(summaries, counts, 9000, 4, 3000);
    expect(pick).not.toBeNull();
    expect(pick!.merge).toEqual([
      "summary-0",
      "summary-1",
      "summary-2",
      "summary-3",
    ]);
    expect(pick!.keep).toEqual([
      "summary-4",
      "summary-5",
      "summary-6",
      "summary-7",
    ]);
  });

  test("null when fewer than two summaries would merge", () => {
    const five = summaries.slice(0, 5);
    const fiveCounts = counts.slice(0, 5);
    // over budget but only summary-0 would merge with keepNewest 4
    expect(pickConsolidation(five, fiveCounts, 7000, 4, 3000)).toBeNull();
  });

  test("null when consolidation would not gain enough", () => {
    // merging two 1500s into a 3000-token L1 gains nothing
    const four = summaries.slice(0, 4);
    const fourCounts = [1500, 1500, 1500, 1500];
    expect(pickConsolidation(four, fourCounts, 5000, 2, 3000)).toBeNull();
  });
});

describe("effectiveSummaryBudget", () => {
  const base = {
    configuredBudget: 12_000,
    floorTokens: 30_000,
    keepRecentTokens: 6000,
    systemPromptTokens: 500,
    summarizerMaxTokens: 1500,
    mergeMaxTokens: 3000,
    keepNewest: 4,
  };

  test("keeps the configured budget when the floor has room", () => {
    const out = effectiveSummaryBudget(base);
    expect(out.budget).toBe(12_000);
    expect(out.floorReachable).toBe(true);
  });

  test("a smaller margin frees budget on a tight floor (small usable windows)", () => {
    const tight = { ...base, floorTokens: 8_000, keepRecentTokens: 1_500, systemPromptTokens: 0 };
    expect(effectiveSummaryBudget(tight).budget).toBe(4_500); // 8,000 − 1,500 − 2,000
    expect(effectiveSummaryBudget({ ...tight, marginTokens: 1_000 }).budget).toBe(5_500);
  });

  test("clamps the budget when the floor is tight", () => {
    const out = effectiveSummaryBudget({ ...base, floorTokens: 15_000 });
    expect(out.budget).toBeLessThan(12_000);
    expect(out.budget).toBeGreaterThan(0);
  });

  test("reports an unreachable floor instead of a negative budget", () => {
    const out = effectiveSummaryBudget({ ...base, floorTokens: 7000 });
    expect(out.floorReachable).toBe(false);
    expect(out.budget).toBeGreaterThan(0); // lower clamp, never negative
  });

  test("unknown context keeps the configured budget", () => {
    const out = effectiveSummaryBudget({ ...base, floorTokens: undefined });
    expect(out.budget).toBe(12_000);
    expect(out.floorReachable).toBe(true);
  });
});
