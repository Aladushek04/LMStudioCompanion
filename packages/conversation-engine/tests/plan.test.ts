import { describe, expect, test } from "vitest";
import { PlanInput, planCompaction } from "../src/plan";
import { CanonMessage } from "../src/view";

// 8 messages = 4 rounds (user/assistant pairs), 100 tokens each.
const msgs: CanonMessage[] = [];
for (let i = 0; i < 4; i++) {
  msgs.push({ role: "user", text: `q${i}` });
  msgs.push({ role: "assistant", text: `a${i}` });
}
const tokens = new Array(8).fill(100);

const base: PlanInput = {
  msgs,
  tokens,
  coveredUpTo: 0,
  summaryTokens: 0,
  estSummaryTokensPerChunk: 50,
  limit: 10_000,
  autoCompact: true,
  force: false,
  keepRecentTokens: 150, // allows cuts up to index 6 (tail = 200 tokens)
  chunkTokens: 200, // one round per chunk
};

describe("planCompaction", () => {
  test("does nothing while under the limit", () => {
    expect(planCompaction(base)).toEqual({ cuts: [], reason: null });
  });

  test("auto mode summarizes only enough chunks to get under the limit", () => {
    // view = 800 tokens, limit 700: dropping round 1 (200 tok) and adding a
    // 50-token summary lands at 650 — one chunk suffices.
    const plan = planCompaction({ ...base, limit: 700 });
    expect(plan.reason).toBe("auto");
    expect(plan.cuts).toEqual([2]);
  });

  test("auto mode takes more chunks when one is not enough", () => {
    // limit 400: after chunk1 est = 800-200+50 = 650, after chunk2 = 500,
    // after chunk3 (cut 6) = 350 < 400.
    const plan = planCompaction({ ...base, limit: 400 });
    expect(plan.cuts).toEqual([2, 4, 6]);
  });

  test("force compresses everything allowed regardless of limit", () => {
    const plan = planCompaction({ ...base, force: true });
    expect(plan.reason).toBe("force");
    expect(plan.cuts).toEqual([2, 4, 6]);
  });

  test("respects keepRecentTokens even when over the limit", () => {
    // keepRecent 850 > total 800: no cut is allowed at all
    const plan = planCompaction({ ...base, limit: 100, keepRecentTokens: 850 });
    expect(plan.cuts).toEqual([]);
  });

  test("auto disabled means no compaction even over the limit", () => {
    const plan = planCompaction({ ...base, limit: 100, autoCompact: false });
    expect(plan).toEqual({ cuts: [], reason: null });
  });

  test("no limit means no auto compaction", () => {
    const plan = planCompaction({ ...base, limit: undefined });
    expect(plan).toEqual({ cuts: [], reason: null });
  });

  test("starts from the already-covered prefix", () => {
    // first 2 messages already summarized into 50 summary tokens;
    // view = 50 + 600 = 650, limit 500 → drop round 2 (200) add 50 → 500 ≤ 500? use < : 500 not < 500 → need another chunk
    const plan = planCompaction({
      ...base,
      coveredUpTo: 2,
      summaryTokens: 50,
      limit: 500,
    });
    expect(plan.reason).toBe("auto");
    expect(plan.cuts).toEqual([4, 6]);
  });

  test("force with nothing new to cover yields no cuts", () => {
    const plan = planCompaction({ ...base, coveredUpTo: 6, force: true });
    expect(plan.cuts).toEqual([]);
  });

  test("maxChunks caps a forced compaction", () => {
    const plan = planCompaction({ ...base, force: true, maxChunks: 2 });
    expect(plan.cuts).toEqual([2, 4]);
  });

  test("maxChunks caps auto compaction even while still over the limit", () => {
    // limit 400 normally takes [2, 4, 6]; the cap stops after one chunk
    const plan = planCompaction({ ...base, limit: 400, maxChunks: 1 });
    expect(plan.reason).toBe("auto");
    expect(plan.cuts).toEqual([2]);
  });

  test("maxChunks of 0 means no cap (auto)", () => {
    const plan = planCompaction({ ...base, force: true, maxChunks: 0 });
    expect(plan.cuts).toEqual([2, 4, 6]);
  });

  test("hysteresis: compacts down to the floor, not just under the trigger", () => {
    // limit 700 alone stops after one chunk (650 < 700); floor 550 keeps
    // going until under 550 so the next turns have real headroom
    const plan = planCompaction({ ...base, limit: 700, floor: 550 });
    expect(plan.reason).toBe("auto");
    expect(plan.cuts).toEqual([2, 4]);
  });

  test("floor defaults to the limit when omitted", () => {
    const plan = planCompaction({ ...base, limit: 700 });
    expect(plan.cuts).toEqual([2]);
  });
});
