import { describe, expect, test } from "vitest";
import { isTransientEngineError } from "../src/retry";

describe("isTransientEngineError", () => {
  test("matches transient engine/channel failures", () => {
    expect(isTransientEngineError(new Error("terminated"))).toBe(true);
    expect(
      isTransientEngineError(
        new Error("Engine protocol predict request failed: fetch failed"),
      ),
    ).toBe(true);
    expect(isTransientEngineError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isTransientEngineError(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransientEngineError(new Error("socket hang up"))).toBe(true);
    expect(
      isTransientEngineError(new Error("channel unexpectedly closed")),
    ).toBe(true);
  });

  test("does not match logic errors that a retry cannot fix", () => {
    expect(
      isTransientEngineError(
        new Error("request (108383 tokens) exceeds the available context size"),
      ),
    ).toBe(false);
    expect(isTransientEngineError(new Error("The operation was aborted"))).toBe(
      false,
    );
    expect(
      isTransientEngineError(new Error("summarizer returned an empty summary")),
    ).toBe(false);
  });

  test("handles non-Error values", () => {
    expect(isTransientEngineError("terminated")).toBe(true);
    expect(isTransientEngineError(undefined)).toBe(false);
    expect(isTransientEngineError(null)).toBe(false);
  });
});
