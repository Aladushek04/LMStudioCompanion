import { describe, expect, test } from "vitest";
import {
  MESSAGE_OVERHEAD_TOKENS,
  charBudget,
  estimateMessageTokens,
  estimateTokens,
} from "../src/estimate";

describe("estimateMessageTokens", () => {
  test("text-only message is its text estimate plus the template overhead", () => {
    const text = "the quick brown fox jumps over the lazy dog. ".repeat(4);
    expect(estimateMessageTokens({ text })).toBe(
      estimateTokens(text) + MESSAGE_OVERHEAD_TOKENS,
    );
  });

  test("counts tool calls and tool results on top of the text", () => {
    const args = JSON.stringify({ url: "https://example.com/some/long/path" });
    const result = "page content ".repeat(50);
    const withCalls = estimateMessageTokens({
      text: "",
      toolCalls: [{ name: "Visit Website", args }],
      toolResults: [{ content: result }],
    });
    expect(withCalls).toBeGreaterThan(estimateTokens(args) + estimateTokens(result));
    expect(withCalls).toBeGreaterThan(estimateMessageTokens({ text: "" }));
  });

  test("inline reasoning in the text counts — the engine keeps it in the pass history", () => {
    const reasoning = "<think>" + "let me think about this step. ".repeat(100) + "</think>";
    expect(estimateMessageTokens({ text: reasoning })).toBeGreaterThan(700);
  });
});

// Plain prose with spaces/punctuation, long enough that no run of 64+
// consecutive base64ish chars ([A-Za-z0-9+/=]) can accidentally form.
const asciiText = "the quick brown fox jumps over the lazy dog. ".repeat(6);
const cjkText = "文".repeat(150);
// A single run of 200 consecutive base64ish chars (>= the 64-char threshold).
const base64Text = "A".repeat(200);

describe("estimateTokens", () => {
  test("empty string is 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("pure ASCII prose is ~length/4", () => {
    const est = estimateTokens(asciiText);
    expect(est).toBe(Math.ceil(asciiText.length / 4));
  });

  test("all-CJK text is ~length/2", () => {
    const est = estimateTokens(cjkText);
    expect(est).toBe(Math.ceil(cjkText.length / 2));
  });

  test("a long base64-ish run is ~length/3", () => {
    const est = estimateTokens(base64Text);
    expect(est).toBe(Math.ceil(base64Text.length / 3));
  });

  test("a base64ish run shorter than 64 chars does NOT get the /3 rate", () => {
    const short = "A".repeat(63);
    expect(estimateTokens(short)).toBe(Math.ceil(short.length / 4));
  });

  test("mixed ASCII+CJK text costs more than pure ASCII, less than pure CJK of the same length", () => {
    const mixed = asciiText + cjkText;
    const est = estimateTokens(mixed);
    // Every char in mixed costs at least the ASCII rate (1/4 token/char) and
    // at most the CJK rate (1/2 token/char).
    expect(est).toBeGreaterThan(Math.ceil(mixed.length / 4));
    expect(est).toBeLessThan(Math.ceil(mixed.length / 2));
  });

  test("is deterministic", () => {
    expect(estimateTokens(asciiText)).toBe(estimateTokens(asciiText));
    expect(estimateTokens(cjkText + base64Text)).toBe(
      estimateTokens(cjkText + base64Text),
    );
  });
});

describe("charBudget", () => {
  test("CJK gets proportionally fewer chars than ASCII for the same token budget", () => {
    const maxTokens = 50;
    const asciiChars = charBudget(asciiText, maxTokens);
    const cjkChars = charBudget(cjkText, maxTokens);
    expect(cjkChars).toBeLessThan(asciiChars);
  });

  test("scales with maxTokens", () => {
    expect(charBudget(asciiText, 100)).toBeGreaterThan(
      charBudget(asciiText, 10),
    );
  });

  test("empty text budgets to 0 chars", () => {
    expect(charBudget("", 100)).toBe(0);
  });
});
