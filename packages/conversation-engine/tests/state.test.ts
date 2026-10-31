import { beforeEach, describe, expect, test } from "vitest";
import {
  WarnCtl,
  getModelState,
  resetModelStates,
  warnOnce,
} from "../src/state";
import { TokenCounter } from "../src/tokens";

const makeCounter = () => new TokenCounter(async (t) => t.length);

beforeEach(() => {
  resetModelStates();
});

describe("getModelState", () => {
  test("evicts the least-recently-used state beyond the cap", () => {
    const first = getModelState("m0", makeCounter);
    getModelState("m1", makeCounter);
    getModelState("m2", makeCounter);
    getModelState("m3", makeCounter);
    getModelState("m4", makeCounter); // 5th distinct id: evicts m0
    const recreated = getModelState("m0", makeCounter);
    expect(recreated.counter).not.toBe(first.counter);
  });

  test("accessing a state refreshes its recency", () => {
    const a = getModelState("a", makeCounter);
    getModelState("b", makeCounter);
    getModelState("c", makeCounter);
    getModelState("d", makeCounter);
    getModelState("a", makeCounter); // touch: a is now most-recently-used
    getModelState("e", makeCounter); // 5th distinct id: evicts b, not a
    expect(getModelState("a", makeCounter).counter).toBe(a.counter);
  });

  test("states are isolated per identifier", () => {
    const a = getModelState("a", makeCounter);
    const b = getModelState("b", makeCounter);
    a.warned.add("floor-unreachable");
    a.lastToolSchemaTokens = 123;
    expect(b.warned.has("floor-unreachable")).toBe(false);
    expect(b.lastToolSchemaTokens).toBeUndefined();
  });
});

describe("warnOnce", () => {
  function fakeCtl(): { ctl: WarnCtl; calls: string[] } {
    const calls: string[] = [];
    return {
      ctl: { createStatus: (s) => calls.push(s.text) },
      calls,
    };
  }

  test("fires the status exactly once per key", () => {
    const { ctl, calls } = fakeCtl();
    const state = getModelState("m", makeCounter);
    warnOnce(ctl, state, "floor-unreachable", "floor text");
    warnOnce(ctl, state, "floor-unreachable", "floor text");
    expect(calls).toEqual(["floor text"]);
    warnOnce(ctl, state, "other-key", "other text");
    expect(calls).toEqual(["floor text", "other text"]);
  });

  test("forwards the requested status, defaulting to error", () => {
    const calls: Array<{ status: string; text: string }> = [];
    const ctl: WarnCtl = {
      createStatus: (s) => calls.push({ status: s.status, text: s.text }),
    };
    const state = getModelState("m", makeCounter);
    warnOnce(ctl, state, "info-key", "info text", "done");
    warnOnce(ctl, state, "error-key", "error text");
    expect(calls).toEqual([
      { status: "done", text: "info text" },
      { status: "error", text: "error text" },
    ]);
  });

  test("keys are per state", () => {
    const { ctl, calls } = fakeCtl();
    const stateA = getModelState("a", makeCounter);
    const stateB = getModelState("b", makeCounter);
    warnOnce(ctl, stateA, "floor-unreachable", "text");
    warnOnce(ctl, stateB, "floor-unreachable", "text");
    expect(calls).toEqual(["text", "text"]);
  });
});
