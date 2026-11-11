import { describe, expect, test } from "vitest";
import { effectiveSizes, pickPromptVariant, SizeConfig } from "../src/budget";

const defaults: Omit<SizeConfig, "contextLength"> = {
  keepRecentTokens: 6000,
  chunkTokens: 16000,
  reservedOutputTokens: 2000,
  summarizerMaxTokens: 1500,
};

// Live failure 2026-08-26: qwen3.8-27b at 16,384 with Agentic Workspace's ten
// tool schemas (~5,300 tokens on every prompt). Every size was clamped against
// the raw 16,384, the floor/trigger were percentages of it, and the engine got
// a 16,557-token request. Sizes must be computed on what is left after the
// fixed overhead.
describe("effectiveSizes with a fixed overhead", () => {
  test("clamps every fraction against the usable window, not the raw context", () => {
    const out = effectiveSizes({
      contextLength: 16_384,
      fixedOverheadTokens: 5_300,
      ...defaults,
      maxToolResultTokens: 4_000,
      roundsPerPass: 6,
    });
    const usable = 16_384 - 5_300; // 11,084
    expect(out.usableContextTokens).toBe(usable);
    expect(out.keepRecentTokens).toBe(Math.floor(usable * 0.25)); // 2,771 < 6,000
    expect(out.chunkTokens).toBe(Math.floor(usable * 0.3)); // 3,325 < 16,000
    expect(out.reservedOutputTokens).toBe(2_000); // 25% (2,771) does not bind
    expect(out.summarizerMaxTokens).toBe(1_500); // 15% (1,662) does not bind
    expect(out.maxToolResultTokens).toBe(Math.floor(usable * 0.15)); // 1,662 < 4,000
    expect(out.roundsPerPass).toBe(1); // max(1, floor(11,084 / 6,000)) = 1 < 6
    expect(out.clamped).toEqual([
      "keepRecentTokens",
      "chunkTokens",
      "maxToolResultTokens",
      "roundsPerPass",
    ]);
    // One round: a reply (~512) plus one capped tool result.
    expect(out.passAllowanceTokens).toBe(1 * (1_662 + 512));
    expect(out.marginTokens).toBe(Math.floor(usable * 0.1)); // 1,108 < 2,000
    expect(out.mergeMaxTokens).toBe(Math.floor(usable * 0.15)); // 1,662 < 3,000
  });

  test("no overhead: the usable window is the context, and unlimited (0) settings are never clamped", () => {
    const out = effectiveSizes({
      contextLength: 65_536,
      ...defaults,
      maxToolResultTokens: 0,
      roundsPerPass: 0,
    });
    expect(out.usableContextTokens).toBe(65_536);
    expect(out.maxToolResultTokens).toBe(0);
    expect(out.roundsPerPass).toBe(0);
    expect(out.clamped).toEqual([]);
    // Unlimited rounds/results: reserve one round at the 2,048 assumption.
    expect(out.passAllowanceTokens).toBe(2_048 + 512);
    expect(out.marginTokens).toBe(2_000);
    expect(out.mergeMaxTokens).toBe(3_000);
  });

  test("large window: tool-result cap and pass length keep their configured values, and the pass reserve is capped at a quarter of the window", () => {
    const out = effectiveSizes({
      contextLength: 65_536,
      fixedOverheadTokens: 5_300,
      ...defaults,
      maxToolResultTokens: 4_000,
      roundsPerPass: 6,
    });
    expect(out.maxToolResultTokens).toBe(4_000);
    expect(out.roundsPerPass).toBe(6);
    // 6 × (4,000 + 512) = 27,072 would be more than a quarter of 60,236.
    expect(out.passAllowanceTokens).toBe(Math.floor((65_536 - 5_300) * 0.25));
  });

  test("an overhead larger than the window clamps everything to its floor instead of going negative", () => {
    const out = effectiveSizes({
      contextLength: 4_096,
      fixedOverheadTokens: 5_000,
      ...defaults,
      maxToolResultTokens: 4_000,
      roundsPerPass: 6,
    });
    expect(out.usableContextTokens).toBe(0);
    expect(out.keepRecentTokens).toBe(512);
    expect(out.maxToolResultTokens).toBe(512);
    expect(out.roundsPerPass).toBe(1);
    expect(out.passAllowanceTokens).toBe(1_024);
    expect(out.marginTokens).toBe(512);
    expect(out.mergeMaxTokens).toBe(400); // 2 × the 200-token summary floor
  });

  test("unknown context: nothing is clamped and the usable window is unknown", () => {
    const out = effectiveSizes({
      contextLength: undefined,
      fixedOverheadTokens: 5_300,
      ...defaults,
      maxToolResultTokens: 4_000,
      roundsPerPass: 6,
    });
    expect(out.usableContextTokens).toBeUndefined();
    expect(out.maxToolResultTokens).toBe(4_000);
    expect(out.roundsPerPass).toBe(6);
    expect(out.passAllowanceTokens).toBe(6 * (4_000 + 512));
    expect(out.marginTokens).toBe(2_000);
    expect(out.mergeMaxTokens).toBe(3_000);
  });
});

describe("effectiveSizes", () => {
  test("ctx 2048: all four clamped to their floors-or-percentages", () => {
    const out = effectiveSizes({ contextLength: 2048, ...defaults });
    expect(out.keepRecentTokens).toBe(512);
    expect(out.chunkTokens).toBe(1024); // floor (1024) beats 30% (614)
    expect(out.reservedOutputTokens).toBe(512);
    expect(out.summarizerMaxTokens).toBe(307);
    expect(out.clamped).toEqual([
      "keepRecentTokens",
      "chunkTokens",
      "reservedOutputTokens",
      "summarizerMaxTokens",
    ]);
  });

  test("ctx 4096 with defaults", () => {
    const out = effectiveSizes({ contextLength: 4096, ...defaults });
    expect(out.keepRecentTokens).toBe(1024);
    expect(out.chunkTokens).toBe(1228);
    expect(out.reservedOutputTokens).toBe(1024);
    expect(out.summarizerMaxTokens).toBe(614);
    expect(out.clamped).toEqual([
      "keepRecentTokens",
      "chunkTokens",
      "reservedOutputTokens",
      "summarizerMaxTokens",
    ]);
  });

  test("ctx 8192 with defaults: reservedOutputTokens cap (2048) >= configured (2000), not clamped", () => {
    const out = effectiveSizes({ contextLength: 8192, ...defaults });
    expect(out.keepRecentTokens).toBe(2048);
    expect(out.chunkTokens).toBe(2457);
    expect(out.reservedOutputTokens).toBe(2000);
    expect(out.summarizerMaxTokens).toBe(1228);
    expect(out.clamped).toEqual([
      "keepRecentTokens",
      "chunkTokens",
      "summarizerMaxTokens",
    ]);
  });

  test("ctx 131072 with defaults: nothing clamped, values pass through", () => {
    const out = effectiveSizes({ contextLength: 131072, ...defaults });
    expect(out.keepRecentTokens).toBe(6000);
    expect(out.chunkTokens).toBe(16000);
    expect(out.reservedOutputTokens).toBe(2000);
    expect(out.summarizerMaxTokens).toBe(1500);
    expect(out.clamped).toEqual([]);
  });

  test("ctx undefined: pass-through, clamped empty", () => {
    const out = effectiveSizes({ contextLength: undefined, ...defaults });
    expect(out.keepRecentTokens).toBe(6000);
    expect(out.chunkTokens).toBe(16000);
    expect(out.reservedOutputTokens).toBe(2000);
    expect(out.summarizerMaxTokens).toBe(1500);
    expect(out.clamped).toEqual([]);
  });

  test("ctx <= 0 is treated like undefined: pass-through", () => {
    const out = effectiveSizes({ contextLength: 0, ...defaults });
    expect(out.clamped).toEqual([]);
    expect(out.keepRecentTokens).toBe(6000);
    const outNeg = effectiveSizes({ contextLength: -1, ...defaults });
    expect(outNeg.clamped).toEqual([]);
  });

  test("a configured value below its cap is never raised", () => {
    const out = effectiveSizes({
      contextLength: 131072,
      ...defaults,
      keepRecentTokens: 500,
    });
    expect(out.keepRecentTokens).toBe(500);
    expect(out.clamped).not.toContain("keepRecentTokens");
  });

  test("floors: tiny ctx still yields at least the floors", () => {
    const out = effectiveSizes({ contextLength: 1000, ...defaults });
    expect(out.keepRecentTokens).toBe(512);
    expect(out.chunkTokens).toBe(1024); // floor exceeds 30% of 1000
    expect(out.reservedOutputTokens).toBe(256);
    expect(out.summarizerMaxTokens).toBe(200);
    expect(out.clamped).toEqual([
      "keepRecentTokens",
      "chunkTokens",
      "reservedOutputTokens",
      "summarizerMaxTokens",
    ]);
  });
});

describe("pickPromptVariant", () => {
  test("forced modes win", () => {
    expect(pickPromptVariant("full")).toBe("full");
    expect(pickPromptVariant("compact")).toBe("compact");
  });

  test("auto always resolves to full (bench 2026-08-24: full beat compact at 3B and 18B)", () => {
    expect(pickPromptVariant("auto")).toBe("full");
  });
});
