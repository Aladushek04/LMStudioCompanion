import { describe, expect, test } from "vitest";
import {
  CanonMessage,
  SENTINEL,
  canon,
  chunkEnds,
  currentTurnStart,
  filterCompressorExchanges,
  fitCuts,
  hasUserMessage,
  isCompressCommand,
  isUsageCommand,
  maxAllowedCut,
  prefixHashes,
  roundBoundaries,
} from "../src/view";

const u = (text: string): CanonMessage => ({ role: "user", text });

describe("currentTurnStart", () => {
  const usr: CanonMessage = { role: "user", text: "u" };
  const asst: CanonMessage = { role: "assistant", text: "a" };
  const tool: CanonMessage = { role: "tool", text: "t" };

  test("is the index of the last user message", () => {
    expect(currentTurnStart([usr, asst, tool, usr, asst])).toBe(3);
    expect(currentTurnStart([usr, asst, tool, asst, usr])).toBe(4);
  });

  test("is 0 when there is no user message at all", () => {
    expect(currentTurnStart([asst, tool])).toBe(0);
    expect(currentTurnStart([])).toBe(0);
  });
});

// Live failure 2026-08-26: with everything older than the verbatim tail
// already summarized, the safety pass had nothing it was allowed to cut and
// sent a prompt 114 tokens under the window; the first tool round overflowed
// it (engine 400, 16,557 vs 16,384). The tail is a preference, the window is
// not: when the prompt does not fit, cut down to the current turn — never into it.
describe("fitCuts", () => {
  const usr: CanonMessage = { role: "user", text: "u" };
  const asst: CanonMessage = { role: "assistant", text: "a" };
  const tool: CanonMessage = { role: "tool", text: "t" };
  // u0 a1 t2 a3 u4 a5 t6 a7 u8 — boundaries [1,3,4,5,7,8], 100 tokens each
  const msgs = [usr, asst, tool, asst, usr, asst, tool, asst, usr];
  const tokens = msgs.map(() => 100);
  const boundaries = roundBoundaries(msgs);
  const turn = currentTurnStart(msgs);

  test("uses the normal keep-recent rule when it yields a cut", () => {
    // keepRecent 300: suffix from 5 is 400, from 7 is 200 → cut at 5
    expect(fitCuts(boundaries, tokens, 0, 10_000, 300, turn)).toEqual({ cuts: [5], relaxed: false });
  });

  test("gives up the verbatim tail down to the current turn when nothing else can be cut", () => {
    // keepRecent 1,000 > everything before the last message → no normal cut
    expect(fitCuts(boundaries, tokens, 0, 10_000, 1_000, turn)).toEqual({ cuts: [8], relaxed: true });
    // chunking still applies to the relaxed range
    expect(fitCuts(boundaries, tokens, 0, 300, 1_000, turn)).toEqual({ cuts: [3, 5, 8], relaxed: true });
  });

  test("never cuts into the current turn, even with no verbatim requirement", () => {
    const inProgress = [usr, asst, tool, usr, asst, tool];
    const t = inProgress.map(() => 100);
    const b = roundBoundaries(inProgress);
    expect(currentTurnStart(inProgress)).toBe(3);
    expect(fitCuts(b, t, 0, 10_000, 0, 3)).toEqual({ cuts: [3], relaxed: false });
  });

  test("reports no cut when the covered prefix already reaches the current turn", () => {
    expect(fitCuts(boundaries, tokens, 8, 10_000, 1_000, turn)).toEqual({ cuts: [], relaxed: true });
  });
});
const a = (text: string): CanonMessage => ({ role: "assistant", text });

describe("canon", () => {
  test("differs when role differs for same text", () => {
    expect(canon(u("hi"))).not.toBe(canon(a("hi")));
  });

  test("includes tool calls and results", () => {
    const withCall: CanonMessage = {
      role: "assistant",
      text: "",
      toolCalls: [{ name: "read_file", args: '{"path":"a.txt"}' }],
    };
    const withResult: CanonMessage = {
      role: "tool",
      text: "",
      toolResults: [{ content: "file contents" }],
    };
    expect(canon(withCall)).toContain("read_file");
    const differentArgs = {
      ...withCall,
      toolCalls: [{ name: "read_file", args: '{"path":"b.txt"}' }],
    };
    expect(canon(differentArgs)).not.toBe(canon(withCall));
    expect(canon(withResult)).toContain("file contents");
  });

  test("includes file attachment names", () => {
    const m: CanonMessage = { role: "user", text: "look", files: ["cat.png"] };
    expect(canon(m)).toContain("cat.png");
  });

  test("is stable: same message yields identical string", () => {
    const m: CanonMessage = {
      role: "assistant",
      text: "x",
      toolCalls: [{ name: "t", args: "{}" }],
    };
    expect(canon(m)).toBe(canon({ ...m }));
  });
});

describe("prefixHashes", () => {
  const msgs = [u("one"), a("two"), u("three")];

  test("returns one hash per message", () => {
    expect(prefixHashes(msgs)).toHaveLength(3);
  });

  test("identical prefixes yield identical hashes", () => {
    const other = [u("one"), a("two"), u("DIFFERENT")];
    const h1 = prefixHashes(msgs);
    const h2 = prefixHashes(other);
    expect(h2[0]).toBe(h1[0]);
    expect(h2[1]).toBe(h1[1]);
    expect(h2[2]).not.toBe(h1[2]);
  });

  test("changing an early message changes all later hashes", () => {
    const edited = [u("EDITED"), a("two"), u("three")];
    const h1 = prefixHashes(msgs);
    const h2 = prefixHashes(edited);
    expect(h2[0]).not.toBe(h1[0]);
    expect(h2[1]).not.toBe(h1[1]);
    expect(h2[2]).not.toBe(h1[2]);
  });

  test("hash depends on position, not only content", () => {
    const aa = [u("x"), u("x")];
    const h = prefixHashes(aa);
    expect(h[0]).not.toBe(h[1]);
  });

  test("a namespace seed changes every hash", () => {
    // summaries produced under different models/prompts/settings must not
    // be reused for one another
    const h1 = prefixHashes(msgs, "namespace-a");
    const h2 = prefixHashes(msgs, "namespace-b");
    const hDefault = prefixHashes(msgs);
    expect(h1[0]).not.toBe(h2[0]);
    expect(h1[2]).not.toBe(h2[2]);
    expect(prefixHashes(msgs, "")).toEqual(hDefault);
  });
});

describe("roundBoundaries", () => {
  test("allows cuts at any non-tool message after index 0", () => {
    const msgs = [u("q1"), a("r1"), u("q2"), a("r2"), u("q3")];
    expect(roundBoundaries(msgs)).toEqual([1, 2, 3, 4]);
  });

  test("never cuts between a tool call and its tool result", () => {
    const msgs: CanonMessage[] = [
      u("q1"),
      { role: "assistant", text: "", toolCalls: [{ name: "t", args: "{}" }] },
      { role: "tool", text: "", toolResults: [{ content: "out" }] },
      a("r1"),
      u("q2"),
    ];
    // cutting before index 2 (the tool result) is forbidden
    expect(roundBoundaries(msgs)).toEqual([1, 3, 4]);
  });

  test("agentic histories with a single user message still have boundaries", () => {
    // long tool loop: user, then assistant/tool pairs — the old user-only
    // rule produced NO cut points here, making chunks unboundedly large
    const msgs: CanonMessage[] = [u("do the task")];
    for (let i = 0; i < 3; i++) {
      msgs.push({
        role: "assistant",
        text: "",
        toolCalls: [{ name: "t", args: "{}" }],
      });
      msgs.push({ role: "tool", text: "", toolResults: [{ content: "out" }] });
    }
    expect(roundBoundaries(msgs)).toEqual([1, 3, 5]);
  });

  test("empty and single-message histories have no boundaries", () => {
    expect(roundBoundaries([])).toEqual([]);
    expect(roundBoundaries([u("hi")])).toEqual([]);
  });
});

describe("maxAllowedCut", () => {
  // msgs: 5 messages with token counts below; boundaries at 2 and 4
  const tokens = [100, 100, 100, 100, 100];
  const boundaries = [2, 4];

  test("returns the largest cut whose tail keeps enough tokens", () => {
    // cut 4 keeps 100 tokens; cut 2 keeps 300
    expect(maxAllowedCut(boundaries, tokens, 100)).toBe(4);
    expect(maxAllowedCut(boundaries, tokens, 250)).toBe(2);
  });

  test("returns 0 when no cut can keep enough recent tokens", () => {
    expect(maxAllowedCut(boundaries, tokens, 1000)).toBe(0);
  });
});

describe("chunkEnds", () => {
  // rounds: [0,2) = 200 tok, [2,4) = 200 tok, [4,6) = 200 tok, tail from 6
  const tokens = [100, 100, 100, 100, 100, 100, 100];
  const boundaries = [2, 4, 6];

  test("groups whole rounds into chunks up to chunkTokens", () => {
    expect(chunkEnds(boundaries, tokens, 0, 400, 6)).toEqual([4, 6]);
  });

  test("a round larger than chunkTokens forms its own chunk", () => {
    expect(chunkEnds(boundaries, tokens, 0, 150, 6)).toEqual([2, 4, 6]);
  });

  test("starts after already-covered prefix and respects maxCut", () => {
    expect(chunkEnds(boundaries, tokens, 2, 400, 4)).toEqual([4]);
  });

  test("returns empty when nothing to chunk", () => {
    expect(chunkEnds(boundaries, tokens, 6, 400, 6)).toEqual([]);
    expect(chunkEnds(boundaries, tokens, 0, 400, 0)).toEqual([]);
  });
});

describe("hasUserMessage", () => {
  // Chat templates (qwen's tool template among them) raise "No user query
  // found in messages" when a conversation has zero user messages — which
  // compaction can produce in tool-heavy chats.
  test("true when any user message exists", () => {
    expect(hasUserMessage([a("x"), u("y")])).toBe(true);
  });

  test("false for assistant/tool-only tails and empty tails", () => {
    const toolOnly: CanonMessage[] = [
      { role: "assistant", text: "", toolCalls: [{ name: "t", args: "{}" }] },
      { role: "tool", text: "", toolResults: [{ content: "out" }] },
      a("done"),
    ];
    expect(hasUserMessage(toolOnly)).toBe(false);
    expect(hasUserMessage([])).toBe(false);
  });
});

describe("compressor exchange filtering", () => {
  test("isCompressCommand matches /compress with whitespace and case", () => {
    expect(isCompressCommand(u("/compress"))).toBe(true);
    expect(isCompressCommand(u("  /COMPRESS  "))).toBe(true);
    expect(isCompressCommand(u("/compression is neat"))).toBe(false);
    expect(isCompressCommand(a("/compress"))).toBe(false);
  });

  test("accepts /compact as an alias of /compress", () => {
    expect(isCompressCommand(u("/compact"))).toBe(true);
    expect(isCompressCommand(u("  /Compact"))).toBe(true);
    expect(isCompressCommand(u("stuff\n/compact"))).toBe(true);
    expect(isCompressCommand(u("/compaction"))).toBe(false);
  });

  test("filters /compact exchanges too", () => {
    const msgs = [u("q"), a("r"), u("/compact"), u("next")];
    expect(filterCompressorExchanges(msgs)).toEqual([msgs[0], msgs[1], msgs[3]]);
  });

  test("isUsageCommand matches /usage like the compress commands", () => {
    expect(isUsageCommand(u("/usage"))).toBe(true);
    expect(isUsageCommand(u("  /USAGE  "))).toBe(true);
    expect(isUsageCommand(u("[injected]\n/usage"))).toBe(true);
    expect(isUsageCommand(u("/usages"))).toBe(false);
    expect(isUsageCommand(a("/usage"))).toBe(false);
  });

  test("filters /usage exchanges from the model's view", () => {
    const msgs = [u("q"), a("r"), u("/usage"), u("next")];
    expect(filterCompressorExchanges(msgs)).toEqual([msgs[0], msgs[1], msgs[3]]);
  });

  test("isCompressCommand survives text injected by prompt preprocessors", () => {
    // other plugins may prepend/append context to the user message; the
    // command still counts when it stands alone on its own line
    expect(isCompressCommand(u("[injected plugin docs]\n/compress"))).toBe(true);
    expect(isCompressCommand(u("/compress\n[appended context]"))).toBe(true);
    expect(isCompressCommand(u("the log said /compress somewhere"))).toBe(false);
  });

  test("drops empty assistant messages (left by canceled/dead replies)", () => {
    const msgs: CanonMessage[] = [
      u("q"),
      { role: "assistant", text: "" }, // canceled reply artifact
      { role: "assistant", text: "  " },
      a("real answer"),
      {
        role: "assistant",
        text: "",
        toolCalls: [{ name: "t", args: "{}" }],
      }, // tool-call-only messages are NOT empty
    ];
    const out = filterCompressorExchanges(msgs);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[3]);
    expect(out[2]).toBe(msgs[4]);
  });

  test("a command with other text keeps the text, dropping only the command line", () => {
    const msgs = [
      u("Please continue fixing the auth code.\n/compress"),
      a("reply"),
    ];
    const out = filterCompressorExchanges(msgs);
    expect(out).toHaveLength(2);
    expect(out[0].text).toContain("Please continue fixing the auth code.");
    expect(out[0].text).not.toContain("/compress");
  });

  test("filters /compress commands and sentinel replies, keeps the rest", () => {
    const msgs = [
      u("real question"),
      a("real answer"),
      u("/compress"),
      a(`${SENTINEL} compacted 100 -> 10 tokens`),
      u("next question"),
    ];
    expect(filterCompressorExchanges(msgs)).toEqual([
      msgs[0],
      msgs[1],
      msgs[4],
    ]);
  });
});
