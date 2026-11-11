import { describe, expect, test } from "vitest";
import {
  CHARS_PER_TOKEN,
  TRUNCATION_MARKER,
  invalidToolRequestResult,
  truncateToolResult,
  wrapToolsWithCap,
} from "../src/toolWrap";

describe("invalidToolRequestResult", () => {
  test("tells the model what went wrong and to retry", () => {
    const out = invalidToolRequestResult(
      "Unterminated string in JSON at position 1681",
    );
    expect(out).toContain("Unterminated string in JSON at position 1681");
    expect(out.toLowerCase()).toContain("try again");
  });

  test("keeps the message single-line and bounded", () => {
    const out = invalidToolRequestResult("line1\nline2\n" + "x".repeat(1000));
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThan(400);
  });
});

describe("truncateToolResult", () => {
  test("short strings pass through unchanged", () => {
    expect(truncateToolResult("hello", 100)).toBe("hello");
  });

  test("long strings keep head AND tail with an omission marker", () => {
    // command output puts errors/exit summaries at the END — tail must survive.
    // Words are space-separated so no run reaches the 64-char base64ish
    // threshold; every char lands in the plain "other" (4 chars/token)
    // class, so estimateTokens(long) = ceil(509/4) = 128, and
    // charBudget(long, 25) = floor(25 * 509/128) = 99 chars (~25 tokens).
    const long = "HEAD " + "word ".repeat(100) + "TAIL";
    const out = truncateToolResult(long, 25) as string;
    expect(out).toContain(TRUNCATION_MARKER);
    expect(out.length).toBeLessThan(300);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
  });

  test("non-string results over the cap are truncated in JSON form", () => {
    const big = { data: "y".repeat(500) };
    const out = truncateToolResult(big, 25) as string;
    expect(typeof out).toBe("string");
    expect(out).toContain(TRUNCATION_MARKER);
  });

  test("non-string results under the cap pass through unchanged", () => {
    const small = { ok: true };
    expect(truncateToolResult(small, 100)).toBe(small);
  });

  test("agentic envelopes preserve recovery IDs instead of blindly truncating the diff", () => {
    const result = {
      protocol: "agentic-workspace/v1",
      ok: true,
      operation: "edit.apply",
      summary: "applied",
      retention: {
        importance: "critical",
        facts: ["transaction tx_keep_me applied"],
        omit_when_summarizing: ["data.diffPreview"],
      },
      artifacts: [
        {
          kind: "diff",
          path: ".agentic/transactions/tx_keep_me/changes.diff",
          sha256: "a".repeat(64),
          bytes: 50_000,
        },
      ],
      data: {
        transactionId: "tx_keep_me",
        status: "applied",
        diffPreview: "d".repeat(50_000),
      },
    };
    const out = truncateToolResult(result, 1200);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("tx_keep_me");
    expect(text).toContain("changes.diff");
    expect(text).not.toContain("d".repeat(100));
  });
});

describe("wrapToolsWithCap", () => {
  const makeTool = (result: unknown) => ({
    name: "reader",
    description: "reads things",
    extraField: "preserved",
    implementation: async (_params: Record<string, unknown>, _ctx: unknown) =>
      result,
  });

  test("preserves tool identity and passes arguments through", async () => {
    const seen: unknown[] = [];
    const tool = {
      ...makeTool("ok"),
      implementation: async (params: Record<string, unknown>, _ctx: unknown) => {
        seen.push(params);
        return "ok";
      },
    };
    const [wrapped] = wrapToolsWithCap([tool], 10);
    expect(wrapped.name).toBe("reader");
    expect(wrapped.description).toBe("reads things");
    expect((wrapped as typeof tool).extraField).toBe("preserved");
    expect(await wrapped.implementation({ path: "a" }, {})).toBe("ok");
    expect(seen).toEqual([{ path: "a" }]);
  });

  test("caps oversized results at ~maxResultTokens", async () => {
    const [wrapped] = wrapToolsWithCap([makeTool("z".repeat(1000))], 10);
    const out = (await wrapped.implementation({}, {})) as string;
    expect(out).toContain(TRUNCATION_MARKER);
    expect(out.length).toBeLessThan(10 * CHARS_PER_TOKEN + 200);
  });

  test("a CJK result is capped to ~maxResultTokens*2 chars, not maxResultTokens*4", async () => {
    // CJK costs ~2 chars/token; the old flat CHARS_PER_TOKEN=4 math would
    // under-truncate it by up to ~2x (keeping ~maxResultTokens*4 chars, twice
    // the intended token budget), letting it blow the context anyway.
    const cjk = "文".repeat(2000);
    const maxResultTokens = 100;
    const [wrapped] = wrapToolsWithCap([makeTool(cjk)], maxResultTokens);
    const out = (await wrapped.implementation({}, {})) as string;
    expect(out).toContain(TRUNCATION_MARKER);
    // Old flat CHARS_PER_TOKEN=4 math would have kept ~400 chars + marker
    // (>maxResultTokens*3); content-aware truncation keeps ~200 + marker.
    expect(out.length).toBeLessThan(maxResultTokens * 3);
  });

  test("cap of 0 disables truncation", async () => {
    const [wrapped] = wrapToolsWithCap([makeTool("z".repeat(1000))], 0);
    expect(await wrapped.implementation({}, {})).toBe("z".repeat(1000));
  });

  test("a throwing tool returns its error as the result instead of crashing the reply", async () => {
    const tool = {
      ...makeTool("unused"),
      implementation: async (_params: Record<string, unknown>, _ctx: unknown) => {
        throw new Error("Process exited with code 1. Stderr:");
      },
    };
    const [wrapped] = wrapToolsWithCap([tool], 100);
    const out = (await wrapped.implementation({}, {})) as string;
    expect(out).toContain("Process exited with code 1");
    expect(out.toLowerCase()).toContain("tool");
  });

  test("a throwing tool still returns its error when capping is disabled", async () => {
    const tool = {
      ...makeTool("unused"),
      implementation: async (_params: Record<string, unknown>, _ctx: unknown) => {
        throw new Error("boom");
      },
    };
    const [wrapped] = wrapToolsWithCap([tool], 0);
    expect((await wrapped.implementation({}, {})) as string).toContain("boom");
  });

  test("aggregate budget clamps results after the total is exhausted", async () => {
    // per-result caps still allow many calls to flood the context; the
    // aggregate budget is the second line of defense
    const tool = makeTool("z".repeat(4000));
    const [wrapped] = wrapToolsWithCap([tool], 1000, 1500);
    const first = (await wrapped.implementation({}, {})) as string;
    const second = (await wrapped.implementation({}, {})) as string;
    expect(first.length).toBeGreaterThan(1000); // per-result cap only
    expect(second.length).toBeLessThan(600); // aggregate budget exhausted
    expect(second).toContain("aggregate");
  });

  test("aggregate budget of 0 disables the aggregate clamp", async () => {
    const tool = makeTool("z".repeat(4000));
    const [wrapped] = wrapToolsWithCap([tool], 1000, 0);
    await wrapped.implementation({}, {});
    const second = (await wrapped.implementation({}, {})) as string;
    expect(second).not.toContain("aggregate");
  });

  test("aborted tool calls rethrow so cancellation still works", async () => {
    const tool = {
      ...makeTool("unused"),
      implementation: async (_params: Record<string, unknown>, _ctx: unknown) => {
        throw new Error("aborted mid-flight");
      },
    };
    const [wrapped] = wrapToolsWithCap([tool], 100);
    const ctx = { signal: AbortSignal.abort() };
    await expect(wrapped.implementation({}, ctx)).rejects.toThrow(
      "aborted mid-flight",
    );
  });
});
