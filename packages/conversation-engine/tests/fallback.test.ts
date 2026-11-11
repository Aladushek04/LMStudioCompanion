import { describe, expect, test } from "vitest";
import { decideFallback } from "../src/fallback";
import { stripReasoning } from "../src/summarizer";

describe("stripReasoning", () => {
  test("removes think spans and keeps the answer", () => {
    expect(stripReasoning("<think>hmm</think>The answer is 4.")).toBe(
      "The answer is 4.",
    );
  });

  test("leaves text without think tags untouched", () => {
    expect(stripReasoning("plain")).toBe("plain");
  });
});

describe("decideFallback", () => {
  test("no fallback when visible content exists", () => {
    expect(
      decideFallback({ visibleChars: 10, reasoningText: "x", toolRequestCount: 0 }),
    ).toBeNull();
  });

  test("promotes reasoning text when the visible reply is empty", () => {
    const fb = decideFallback({
      visibleChars: 0,
      reasoningText: "<think>let me see</think>The plan is ready.",
      toolRequestCount: 0,
    });
    expect(fb).toEqual({ kind: "promote", text: "The plan is ready." });
  });

  test("promotes raw reasoning when everything was inside think tags", () => {
    const fb = decideFallback({
      visibleChars: 0,
      reasoningText: "<think>only thoughts here</think>",
      toolRequestCount: 0,
    });
    expect(fb?.kind).toBe("promote");
    expect(fb?.text).toContain("only thoughts here");
  });

  test("promoted text is sanitized of internal LM Studio markers", () => {
    const fb = decideFallback({
      visibleChars: 0,
      reasoningText:
        "The answer is ready.\nLM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_f4e9a8d2c6b14d0c9e5f3a7b8c1d2e6a",
      toolRequestCount: 0,
    });
    expect(fb?.kind).toBe("promote");
    expect(fb?.text).toContain("The answer is ready.");
    expect(fb?.text).not.toContain("LM_STUDIO_INTERNAL");
  });

  test("tool-only turns need no fallback", () => {
    expect(
      decideFallback({ visibleChars: 0, reasoningText: "", toolRequestCount: 2 }),
    ).toBeNull();
  });

  test("truly empty turns get an explicit notice", () => {
    const fb = decideFallback({
      visibleChars: 0,
      reasoningText: "  ",
      toolRequestCount: 0,
    });
    expect(fb?.kind).toBe("notice");
    expect(fb?.text).toContain("no output");
  });

  // Non-<think> families must behave exactly like <think> did above: the
  // visible tail after the span is promoted, and an all-reasoning turn
  // promotes the raw content with just the marker literals removed.
  describe("non-<think> marker families", () => {
    test("Magistral [THINK]...[/THINK]: promotes the text after the span", () => {
      const fb = decideFallback({
        visibleChars: 0,
        reasoningText: "[THINK]let me see[/THINK]The plan is ready.",
        toolRequestCount: 0,
      });
      expect(fb).toEqual({ kind: "promote", text: "The plan is ready." });
    });

    test("Magistral [THINK]...[/THINK]: promotes raw text when all-reasoning", () => {
      const fb = decideFallback({
        visibleChars: 0,
        reasoningText: "[THINK]only thoughts here[/THINK]",
        toolRequestCount: 0,
      });
      expect(fb?.kind).toBe("promote");
      expect(fb?.text).toContain("only thoughts here");
    });

    test("Kimi ◁think▷...◁/think▷: promotes the text after the span", () => {
      const fb = decideFallback({
        visibleChars: 0,
        reasoningText: "◁think▷let me see◁/think▷The plan is ready.",
        toolRequestCount: 0,
      });
      expect(fb).toEqual({ kind: "promote", text: "The plan is ready." });
    });

    test("Kimi ◁think▷...◁/think▷: promotes raw text when all-reasoning", () => {
      const fb = decideFallback({
        visibleChars: 0,
        reasoningText: "◁think▷only thoughts here◁/think▷",
        toolRequestCount: 0,
      });
      expect(fb?.kind).toBe("promote");
      expect(fb?.text).toContain("only thoughts here");
    });

    test("<reasoning>...</reasoning>: promotes the text after the span", () => {
      const fb = decideFallback({
        visibleChars: 0,
        reasoningText: "<reasoning>let me see</reasoning>The plan is ready.",
        toolRequestCount: 0,
      });
      expect(fb).toEqual({ kind: "promote", text: "The plan is ready." });
    });

    test("<reasoning>...</reasoning>: promotes raw text when all-reasoning", () => {
      const fb = decideFallback({
        visibleChars: 0,
        reasoningText: "<reasoning>only thoughts here</reasoning>",
        toolRequestCount: 0,
      });
      expect(fb?.kind).toBe("promote");
      expect(fb?.text).toContain("only thoughts here");
    });

    test("Harmony analysis channel: promotes the final-channel text after it", () => {
      const fb = decideFallback({
        visibleChars: 0,
        reasoningText:
          "<|channel|>analysis<|message|>let me see<|end|>The plan is ready.",
        toolRequestCount: 0,
      });
      expect(fb).toEqual({ kind: "promote", text: "The plan is ready." });
    });

    test("Harmony analysis channel: promotes raw text when all-reasoning", () => {
      const fb = decideFallback({
        visibleChars: 0,
        reasoningText: "<|channel|>analysis<|message|>only thoughts here",
        toolRequestCount: 0,
      });
      expect(fb?.kind).toBe("promote");
      expect(fb?.text).toContain("only thoughts here");
    });
  });
});
