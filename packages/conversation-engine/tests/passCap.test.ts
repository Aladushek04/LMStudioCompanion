import { describe, expect, test } from "vitest";
import {
  GROWTH_CUSHION,
  PassCapAbort,
  createPassCap,
  nextRoundFits,
} from "../src/passCap";

describe("nextRoundFits", () => {
  const base = {
    startTokens: 10_000,
    toolSchemaTokens: 1_000,
    reservedOutputTokens: 2_000,
    contextLength: 16_384,
  };

  test("fits while the grown history leaves the reply reserve", () => {
    expect(nextRoundFits({ ...base, grownTokens: 0 })).toBe(true);
    expect(nextRoundFits({ ...base, grownTokens: 3_000 })).toBe(true);
  });

  test("the live 400: one reasoning-heavy round plus a page fetch no longer fits", () => {
    // 14,848-token window; the pass started at a fitted prompt, then one
    // round of ~2,800 tokens of reasoning plus a ~2,000-token page result.
    expect(
      nextRoundFits({
        startTokens: 10_500,
        toolSchemaTokens: 900,
        grownTokens: 4_800,
        reservedOutputTokens: 1_500,
        contextLength: 14_848,
      }),
    ).toBe(false);
  });

  test("applies the growth cushion to the estimate", () => {
    const room = base.contextLength - base.startTokens - base.toolSchemaTokens - base.reservedOutputTokens;
    // Exactly the room, before cushion: would fit without it, does not with it.
    expect(GROWTH_CUSHION).toBeGreaterThan(1);
    expect(nextRoundFits({ ...base, grownTokens: room })).toBe(false);
    expect(nextRoundFits({ ...base, grownTokens: Math.floor(room / GROWTH_CUSHION) - 1 })).toBe(true);
  });
});

describe("createPassCap", () => {
  test("ends the pass at the end of the last allowed round, not before", () => {
    const parent = new AbortController();
    const cap = createPassCap({ maxRounds: 3, parentSignal: parent.signal });
    cap.onRoundEnd(0);
    cap.onRoundEnd(1);
    expect(cap.signal.aborted).toBe(false);
    expect(cap.reason()).toBeUndefined();
    cap.onRoundEnd(2);
    expect(cap.signal.aborted).toBe(true);
    expect(cap.reason()).toBe("rounds");
    expect(cap.isCapAbort()).toBe(true);
    expect(cap.signal.reason).toBeInstanceOf(PassCapAbort);
  });

  test("no round limit means the pass is never capped by rounds", () => {
    const parent = new AbortController();
    for (const maxRounds of [undefined, 0, -1]) {
      const cap = createPassCap({ maxRounds, parentSignal: parent.signal });
      for (let i = 0; i < 50; i++) cap.onRoundEnd(i);
      expect(cap.signal.aborted).toBe(false);
      expect(cap.reason()).toBeUndefined();
    }
  });

  test("ends the pass early when the next round would not fit", () => {
    const parent = new AbortController();
    const seen: number[] = [];
    const cap = createPassCap({
      maxRounds: 10,
      parentSignal: parent.signal,
      wouldOverflow: (completed) => {
        seen.push(completed);
        return completed >= 2;
      },
    });
    cap.onRoundEnd(0);
    expect(cap.signal.aborted).toBe(false);
    cap.onRoundEnd(1);
    expect(cap.signal.aborted).toBe(true);
    expect(cap.reason()).toBe("fit");
    expect(seen).toEqual([1, 2]);
  });

  test("the round limit wins over the fit check on the same round", () => {
    const parent = new AbortController();
    const cap = createPassCap({
      maxRounds: 1,
      parentSignal: parent.signal,
      wouldOverflow: () => true,
    });
    cap.onRoundEnd(0);
    expect(cap.reason()).toBe("rounds");
  });

  test("mirrors the user's abort and is then not a cap abort", () => {
    const parent = new AbortController();
    const cap = createPassCap({ maxRounds: 2, parentSignal: parent.signal });
    const userReason = new Error("user stopped");
    parent.abort(userReason);
    expect(cap.signal.aborted).toBe(true);
    expect(cap.signal.reason).toBe(userReason);
    expect(cap.isCapAbort()).toBe(false);
    // A round ending after the user's stop never re-labels the abort.
    cap.onRoundEnd(1);
    expect(cap.reason()).toBeUndefined();
    expect(cap.isCapAbort()).toBe(false);
  });

  test("an already-aborted parent aborts immediately", () => {
    const parent = new AbortController();
    parent.abort();
    const cap = createPassCap({ maxRounds: 2, parentSignal: parent.signal });
    expect(cap.signal.aborted).toBe(true);
    expect(cap.isCapAbort()).toBe(false);
  });

  test("a user stop after the cap does not turn the cap into a user abort of the pass result", () => {
    const parent = new AbortController();
    const cap = createPassCap({ maxRounds: 1, parentSignal: parent.signal });
    cap.onRoundEnd(0);
    expect(cap.isCapAbort()).toBe(true);
    parent.abort();
    // The caller checks the parent signal itself (guardAbort); the cap only
    // reports that it did not cause the abort once the user has stopped.
    expect(cap.isCapAbort()).toBe(false);
  });
});
