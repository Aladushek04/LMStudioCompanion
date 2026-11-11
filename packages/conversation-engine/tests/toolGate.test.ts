import { describe, expect, test } from "vitest";
import { decideTools } from "../src/toolGate";

describe("decideTools", () => {
  test("trained model with session tools: pass, no warning", () => {
    const result = decideTools({
      sessionToolCount: 3,
      trainedForToolUse: true,
    });
    expect(result.passTools).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  test("trained model with no session tools: pass, no warning", () => {
    const result = decideTools({
      sessionToolCount: 0,
      trainedForToolUse: true,
    });
    expect(result.passTools).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  test("untrained model with session tools: drop, warning mentions the count", () => {
    const result = decideTools({
      sessionToolCount: 3,
      trainedForToolUse: false,
    });
    expect(result.passTools).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("4"); // 3 session tools + the plugin's own get_context_usage
  });

  test("untrained model with no session tools at all: drop, no warning", () => {
    const result = decideTools({
      sessionToolCount: 0,
      trainedForToolUse: false,
    });
    expect(result.passTools).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  test("capability unknown (probe failed): pass, no warning (benefit of the doubt)", () => {
    const result = decideTools({
      sessionToolCount: 3,
      trainedForToolUse: undefined,
    });
    expect(result.passTools).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});
