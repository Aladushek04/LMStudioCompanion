import { describe, expect, test } from "vitest";
import { CanonMessage } from "../src/view";
import { ViewMsg, planViewMessages, promptChatMessages } from "../src/viewPlan";

const SYNTH = "Continue the task described in the summary above from where it left off.";

const u = (text: string): CanonMessage => ({ role: "user", text });
const a = (text: string): CanonMessage => ({ role: "assistant", text });
const s = (text: string): CanonMessage => ({ role: "system", text });
const t = (text: string): CanonMessage => ({ role: "tool", text });

describe("planViewMessages — system strategy", () => {
  test("leading system message when systemText is set", () => {
    const out = planViewMessages("SYS", [u("hi")], "system", SYNTH);
    expect(out[0]).toEqual({ role: "system", text: "SYS" });
  });

  test("no system message when systemText is undefined", () => {
    const out = planViewMessages(undefined, [u("hi")], "system", SYNTH);
    expect(out.some((m) => m.role === "system")).toBe(false);
  });

  test("tail raw indices preserved for a mixed tail, byte-identical to hand-built expectation", () => {
    const tail = [u("q1"), a("r1"), t("tool out")];
    const out = planViewMessages("SYS", tail, "system", SYNTH);
    const expected: ViewMsg[] = [
      { role: "system", text: "SYS" },
      { role: "user", text: "q1", fromTailIndex: 0 },
      { role: "assistant", text: "r1", fromTailIndex: 1 },
      { role: "tool", text: "tool out", fromTailIndex: 2 },
    ];
    expect(out).toEqual(expected);
  });

  test("synthetic user injected when tail has no user message", () => {
    const tail = [a("r1"), t("tool out")];
    const out = planViewMessages("SYS", tail, "system", SYNTH);
    expect(out).toEqual([
      { role: "system", text: "SYS" },
      { role: "user", text: SYNTH },
      { role: "assistant", text: "r1", fromTailIndex: 0 },
      { role: "tool", text: "tool out", fromTailIndex: 1 },
    ]);
  });

  test("no synthetic user injected when tail already has a user message", () => {
    const out = planViewMessages("SYS", [a("r1"), u("q1")], "system", SYNTH);
    expect(out.filter((m) => m.text === SYNTH)).toHaveLength(0);
  });

  test("mid-history system message downgraded to [system note] user text, no fromTailIndex", () => {
    const tail = [u("q1"), s("be nice"), a("r1")];
    const out = planViewMessages("SYS", tail, "system", SYNTH);
    expect(out).toEqual([
      { role: "system", text: "SYS" },
      { role: "user", text: "q1", fromTailIndex: 0 },
      { role: "user", text: "[system note] be nice" },
      { role: "assistant", text: "r1", fromTailIndex: 2 },
    ]);
  });

  test("empty tail: only system + synthetic user", () => {
    const out = planViewMessages("SYS", [], "system", SYNTH);
    expect(out).toEqual([
      { role: "system", text: "SYS" },
      { role: "user", text: SYNTH },
    ]);
  });
});

describe("planViewMessages — foldSystem strategy: never emits role 'system'", () => {
  const cases: Record<string, CanonMessage[]> = {
    "empty tail": [],
    "user-first tail": [u("q1"), a("r1")],
    "assistant-first tail": [a("r1"), u("q2")],
    "tool-first tail": [t("out"), a("r1")],
    "system-first tail": [s("be nice"), u("q1")],
    "mixed with mid-history system": [u("q1"), s("note"), a("r1"), t("out")],
    "no user anywhere": [a("r1"), t("out")],
  };
  for (const [name, tail] of Object.entries(cases)) {
    test(`no system role for: ${name}`, () => {
      const out = planViewMessages("SYS", tail, "foldSystem", SYNTH);
      expect(out.every((m) => m.role !== "system")).toBe(true);
    });
    test(`no system role for (undefined systemText): ${name}`, () => {
      const out = planViewMessages(undefined, tail, "foldSystem", SYNTH);
      expect(out.every((m) => m.role !== "system")).toBe(true);
    });
  }
});

describe("planViewMessages — foldSystem strategy: specific shapes", () => {
  test("first tail message is user: text-merged, fromTailIndex unset, others keep raw indices", () => {
    const tail = [u("q1"), a("r1"), u("q2")];
    const out = planViewMessages("SYS", tail, "foldSystem", SYNTH);
    expect(out).toEqual([
      { role: "user", text: "SYS\n\nq1" },
      { role: "assistant", text: "r1", fromTailIndex: 1 },
      { role: "user", text: "q2", fromTailIndex: 2 },
    ]);
  });

  test("tail starts with assistant: new leading user with systemText + synthetic text, tail unchanged", () => {
    const tail = [a("r1"), u("q1")];
    const out = planViewMessages("SYS", tail, "foldSystem", SYNTH);
    expect(out).toEqual([
      { role: "user", text: `SYS\n\n${SYNTH}` },
      { role: "assistant", text: "r1", fromTailIndex: 0 },
      { role: "user", text: "q1", fromTailIndex: 1 },
    ]);
  });

  test("tail starts with tool: new leading user with systemText + synthetic text", () => {
    const tail = [t("out"), a("r1")];
    const out = planViewMessages("SYS", tail, "foldSystem", SYNTH);
    expect(out[0]).toEqual({ role: "user", text: `SYS\n\n${SYNTH}` });
  });

  test("empty tail: single user message with systemText + synthetic text", () => {
    const out = planViewMessages("SYS", [], "foldSystem", SYNTH);
    expect(out).toEqual([{ role: "user", text: `SYS\n\n${SYNTH}` }]);
  });

  test("undefined systemText: identity with system strategy minus the system message, raw indices intact", () => {
    const tail = [u("q1"), s("note"), a("r1"), t("out")];
    const foldOut = planViewMessages(undefined, tail, "foldSystem", SYNTH);
    const systemOut = planViewMessages(undefined, tail, "system", SYNTH);
    expect(systemOut.some((m) => m.role === "system")).toBe(false);
    expect(foldOut).toEqual(systemOut);
  });

  test("undefined systemText, no user in tail: synthetic user injected (system-minus behavior)", () => {
    const tail = [a("r1"), t("out")];
    const out = planViewMessages(undefined, tail, "foldSystem", SYNTH);
    expect(out[0]).toEqual({ role: "user", text: SYNTH });
  });

  test("no double synthetic user when fold already emitted the leading user (assistant-first, tail has no user at all)", () => {
    const tail = [a("r1"), t("out")];
    const out = planViewMessages("SYS", tail, "foldSystem", SYNTH);
    expect(out).toEqual([
      { role: "user", text: `SYS\n\n${SYNTH}` },
      { role: "assistant", text: "r1", fromTailIndex: 0 },
      { role: "tool", text: "out", fromTailIndex: 1 },
    ]);
    expect(out.filter((m) => m.text.includes(SYNTH))).toHaveLength(1);
  });

  test("mid-history system message inside the tail still downgraded to [system note] user text", () => {
    const tail = [u("q1"), s("be nice"), a("r1")];
    const out = planViewMessages("SYS", tail, "foldSystem", SYNTH);
    expect(out).toEqual([
      { role: "user", text: "SYS\n\nq1" },
      { role: "user", text: "[system note] be nice" },
      { role: "assistant", text: "r1", fromTailIndex: 2 },
    ]);
  });

  test("system-first tail (not user, not assistant/tool explicitly): treated as 'otherwise' — leading synthetic user, then tail with system downgraded", () => {
    const tail = [s("be nice"), u("q1")];
    const out = planViewMessages("SYS", tail, "foldSystem", SYNTH);
    expect(out).toEqual([
      { role: "user", text: `SYS\n\n${SYNTH}` },
      { role: "user", text: "[system note] be nice" },
      { role: "user", text: "q1", fromTailIndex: 1 },
    ]);
  });
});

describe("promptChatMessages", () => {
  const prompt = { system: "SYSTEM PROMPT", user: "USER PROMPT" };

  test("'system' strategy: system + user messages, unmerged", () => {
    expect(promptChatMessages(prompt, "system")).toEqual([
      { role: "system", content: "SYSTEM PROMPT" },
      { role: "user", content: "USER PROMPT" },
    ]);
  });

  test("'foldSystem' strategy: single user message, no system role", () => {
    const out = promptChatMessages(prompt, "foldSystem");
    expect(out).toHaveLength(1);
    expect(out.every((m) => m.role !== "system")).toBe(true);
  });

  test("'foldSystem' strategy: text concatenation is system + blank line + user, verbatim", () => {
    const out = promptChatMessages(prompt, "foldSystem");
    expect(out).toEqual([
      { role: "user", content: "SYSTEM PROMPT\n\nUSER PROMPT" },
    ]);
  });

  test("'foldSystem' never emits a system role regardless of prompt content", () => {
    const weird = { system: "", user: "" };
    const out = promptChatMessages(weird, "foldSystem");
    expect(out.every((m) => m.role !== "system")).toBe(true);
    expect(out).toEqual([{ role: "user", content: "\n\n" }]);
  });
});
