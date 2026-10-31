import { describe, expect, test } from "vitest";
import { TokenCounter } from "../src/tokens";
import { CanonMessage } from "../src/view";

const msg = (text: string): CanonMessage => ({ role: "user", text });

describe("TokenCounter", () => {
  test("counts include the per-message overhead", async () => {
    const counter = new TokenCounter(async (t) => t.length, 4);
    const m = msg("12345");
    // canon() is longer than the raw text; assert overhead is added on top
    const withOverhead = await counter.countMessage(m);
    const counterNoOverhead = new TokenCounter(async (t) => t.length, 0);
    expect(withOverhead).toBe((await counterNoOverhead.countMessage(m)) + 4);
  });

  test("memoizes: identical messages hit the tokenizer once", async () => {
    let calls = 0;
    const counter = new TokenCounter(async (t) => {
      calls++;
      return t.length;
    });
    const m = msg("hello");
    await counter.countMessage(m);
    await counter.countMessage({ ...m });
    await counter.countMessages([m, { ...m }]);
    expect(calls).toBe(1);
  });

  test("countMessages aligns with input order", async () => {
    const counter = new TokenCounter(async (t) => t.length, 0);
    const a = msg("aa");
    const b = msg("bbbb");
    const [ca, cb] = await counter.countMessages([a, b]);
    expect(cb).toBeGreaterThan(ca);
  });

  test("counts the plain-text rendering, not the canon JSON scaffolding — memoized on canon", async () => {
    const seen: string[] = [];
    const counter = new TokenCounter(async (t) => {
      seen.push(t);
      return t.length;
    });
    const m: CanonMessage = {
      role: "user",
      text: "hello",
      toolCalls: [{ name: "search", args: '{"q":"x"}' }],
      toolResults: [{ content: "result text" }],
      files: ["a.png"],
    };
    await counter.countMessage(m);
    await counter.countMessage({ ...m }); // same content, distinct object
    // memoized: identical canon key means the counter fn runs only once
    expect(seen).toHaveLength(1);
    for (const s of seen) {
      expect(s).not.toContain('{"role"');
    }
    expect(seen.some((s) => s.includes("user: hello"))).toBe(true);
  });
});
