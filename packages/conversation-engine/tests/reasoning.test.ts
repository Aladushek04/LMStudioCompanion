import { describe, expect, test } from "vitest";
import {
  burnedOutInReasoning,
  extractPayload,
  isTruncatedStop,
  noThinkDirective,
  stripReasoningMarkers,
  stripSyntheticReasoning,
} from "../src/reasoning";

describe("burnedOutInReasoning", () => {
  test("empty payload with a truncated stop is a burn", () => {
    expect(burnedOutInReasoning("", "maxPredictedTokensReached")).toBe(true);
    expect(burnedOutInReasoning("", "contextLengthReached")).toBe(true);
  });

  test("a natural stop or any payload is not a burn", () => {
    expect(burnedOutInReasoning("", "eosFound")).toBe(false);
    expect(burnedOutInReasoning("", undefined)).toBe(false);
    expect(burnedOutInReasoning("text", "maxPredictedTokensReached")).toBe(false);
  });
});

// LM Studio 0.4.15 flattens a handler-produced reply to
// "<reasoning>__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_<hex>__<content>"
// (one such pair per tool round, all in one text) before handing it back as
// history. Observed on qwen3.8-27b: the model started echoing the marker.
const END = "__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_f4e9a8d2c6b14d0c9e5f3a7b8c1d2e6a__";

describe("stripSyntheticReasoning", () => {
  test("keeps only the content after the marker", () => {
    expect(
      stripSyntheticReasoning(`Let me inspect the workspace first.\n${END}The workspace is empty.`),
    ).toBe("The workspace is empty.");
  });

  test("with one marker per tool round, keeps what follows the last one", () => {
    const text = `think 1\n${END}Reading files.think 2\n${END}Found the bug in add().`;
    expect(stripSyntheticReasoning(text)).toBe("Found the bug in add().");
  });

  test("a reasoning-only reply becomes empty", () => {
    expect(stripSyntheticReasoning(`only thinking here\n${END}`)).toBe("");
    expect(stripSyntheticReasoning(END)).toBe("");
  });

  test("text without the marker is returned untouched, whitespace included", () => {
    expect(stripSyntheticReasoning("  plain reply \n")).toBe("  plain reply \n");
  });

  test("removes any other LM_STUDIO_INTERNAL marker literal without eating adjacent words", () => {
    expect(
      stripSyntheticReasoning("done.\nLM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_f4e9a8d2c6b14d0c9e5f3a7b8c1d2e6a"),
    ).toBe("done.");
    expect(stripSyntheticReasoning(`${END}The answer`)).toBe("The answer");
  });

  test("stripReasoningMarkers applies the same rule", () => {
    expect(stripReasoningMarkers(`hmm\n${END}<think>more</think>final`)).toBe("final");
  });
});

describe("stripReasoningMarkers", () => {
  test("strips a terminated <think> span, preserving text before/after", () => {
    expect(
      stripReasoningMarkers("before<think>hmm, let me think</think>after"),
    ).toBe("beforeafter");
  });

  test("strips an unterminated <think> span through end of text", () => {
    expect(stripReasoningMarkers("kept<think>never closes")).toBe("kept");
  });

  test("strips [THINK]...[/THINK], and an unterminated [THINK]", () => {
    expect(stripReasoningMarkers("a[THINK]stuff[/THINK]b")).toBe("ab");
    expect(stripReasoningMarkers("a[THINK]stuff never closes")).toBe("a");
  });

  test("strips Kimi ◁think▷...◁/think▷", () => {
    expect(stripReasoningMarkers("a◁think▷pondering◁/think▷b")).toBe("ab");
    expect(stripReasoningMarkers("a◁think▷pondering forever")).toBe("a");
  });

  test("strips <reasoning>...</reasoning>", () => {
    expect(stripReasoningMarkers("a<reasoning>deep thoughts</reasoning>b")).toBe(
      "ab",
    );
    expect(stripReasoningMarkers("a<reasoning>deep thoughts forever")).toBe("a");
  });

  describe("Harmony channels", () => {
    test("strips the analysis channel terminated by <|end|>, keeping later text", () => {
      const text =
        "<|channel|>analysis<|message|>thinking hard<|end|>the answer is 4";
      expect(stripReasoningMarkers(text)).toBe("the answer is 4");
    });

    test("strips the analysis channel terminated by the final-channel start, keeping final text", () => {
      const text =
        "<|channel|>analysis<|message|>thinking hard" +
        "<|start|>assistant<|channel|>final<|message|>the answer is 4";
      expect(stripReasoningMarkers(text)).toBe("the answer is 4");
    });

    test("strips an unterminated analysis channel through end of text", () => {
      const text = "<|channel|>analysis<|message|>thinking that never ends";
      expect(stripReasoningMarkers(text)).toBe("");
    });

    test("unwraps a bare leading final-channel prefix", () => {
      const text = "<|channel|>final<|message|>the answer is 4";
      expect(stripReasoningMarkers(text)).toBe("the answer is 4");
    });

    // Regression: the standard two-channel gpt-oss completion shape — the
    // analysis channel terminated by <|end|>, immediately followed by the
    // final channel's own header — used to leak the final-channel header
    // literal because the terminator alternation only consumed the <|end|>.
    test("strips a <|end|>-terminated analysis channel immediately followed by a final header", () => {
      const text =
        "<|channel|>analysis<|message|>thinking<|end|>" +
        "<|start|>assistant<|channel|>final<|message|>answer";
      expect(stripReasoningMarkers(text)).toBe("answer");
    });

    // Regression: canonical Harmony output prefixes every channel header
    // (including the analysis opener itself) with <|start|>assistant; the
    // opener pattern must tolerate that prefix too, not just the closer.
    test("strips a <|start|>assistant-prefixed analysis opener, doubly wrapped with a final header", () => {
      const text =
        "<|start|>assistant<|channel|>analysis<|message|>thinking<|end|>" +
        "<|start|>assistant<|channel|>final<|message|>answer";
      expect(stripReasoningMarkers(text)).toBe("answer");
    });
  });

  test("strips multiple spans in one text", () => {
    const text = "<think>a</think>keep1<think>b</think>keep2";
    expect(stripReasoningMarkers(text)).toBe("keep1keep2");
  });

  test("text with no markers is returned trimmed but otherwise unchanged", () => {
    expect(stripReasoningMarkers("  plain answer  ")).toBe("plain answer");
    expect(stripReasoningMarkers("plain answer")).toBe("plain answer");
  });
});

describe("extractPayload", () => {
  test("prefers nonReasoningContent when present", () => {
    expect(
      extractPayload({
        content: "<think>x</think>ignored",
        reasoningContent: "x",
        nonReasoningContent: "the real answer",
      }),
    ).toBe("the real answer");
  });

  test("falls back to content when nonReasoningContent is absent", () => {
    expect(extractPayload({ content: "<think>x</think>the real answer" })).toBe(
      "the real answer",
    );
  });

  test("still strips markers out of nonReasoningContent", () => {
    expect(
      extractPayload({
        content: "irrelevant",
        nonReasoningContent: "<think>x</think>the real answer",
      }),
    ).toBe("the real answer");
  });

  test("returns empty string for all-reasoning results", () => {
    expect(
      extractPayload({
        content: "<think>only thoughts</think>",
        reasoningContent: "only thoughts",
        nonReasoningContent: "",
      }),
    ).toBe("");
  });
});

describe("isTruncatedStop", () => {
  test("true for maxPredictedTokensReached", () => {
    expect(isTruncatedStop("maxPredictedTokensReached")).toBe(true);
  });

  test("true for contextLengthReached", () => {
    expect(isTruncatedStop("contextLengthReached")).toBe(true);
  });

  test("false for eosFound", () => {
    expect(isTruncatedStop("eosFound")).toBe(false);
  });

  test("false for undefined", () => {
    expect(isTruncatedStop(undefined)).toBe(false);
  });
});

describe("noThinkDirective", () => {
  test.each([
    ["qwen/qwen3.8-27b", undefined],
    ["qwen3.6-27b-nemesis", undefined],
    ["qwen3-14b-abliterated", "/no_think"],
    ["qwen35-arch-model", undefined],
    ["qwq-32b", "/no_think"],
    ["smollm3-3b", "/no_think"],
    ["glm-4-9b", "/nothink"],
    ["qwen2.5-7b-instruct", undefined],
    ["mistral-7b", undefined],
    [undefined, undefined],
  ])("noThinkDirective(%s) === %s", (identifier, expected) => {
    expect(noThinkDirective(identifier)).toBe(expected);
  });
});
