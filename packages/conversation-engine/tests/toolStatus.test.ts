import { describe, expect, test } from "vitest";
import {
  type ToolStatusSink,
  type ToolStatusState,
  runWithToolStatus,
} from "../src/toolStatus";
import { toolErrorResult } from "../src/toolWrap";

interface Recorded {
  callId: number;
  states: ToolStatusState[];
  texts: string[];
  warnings: string[];
}

function fakeFactory(created: Recorded[], opts: { throwOn?: "create" | "update" } = {}) {
  return (callId: number, initial: ToolStatusState): ToolStatusSink => {
    if (opts.throwOn === "create") throw new Error("status detached");
    const rec: Recorded = { callId, states: [initial], texts: [], warnings: [] };
    created.push(rec);
    const guard = () => {
      if (opts.throwOn === "update") throw new Error("status detached");
    };
    return {
      setCustomStatusText: (text) => {
        guard();
        rec.texts.push(text);
      },
      addWarning: (text) => {
        guard();
        rec.warnings.push(text);
      },
      setStatus: (state) => {
        guard();
        rec.states.push(state);
      },
    };
  };
}

describe("runWithToolStatus", () => {
  test("forwards the tool's status and warnings to a per-call tool status", async () => {
    const created: Recorded[] = [];
    let seenCtx: { status: (t: string) => void; warn: (t: string) => void } | undefined;
    const result = await runWithToolStatus(
      { callId: 7, status: () => {}, warn: () => {} },
      fakeFactory(created),
      async (ctx) => {
        seenCtx = ctx;
        ctx.status("Searching the web…");
        ctx.status("Reading 3 results…");
        ctx.warn("one result timed out");
        return "ok";
      },
      () => 0,
    );
    expect(result).toBe("ok");
    expect(seenCtx).toBeDefined();
    expect(created).toHaveLength(1);
    expect(created[0].callId).toBe(7);
    expect(created[0].states[0]).toEqual({ type: "callingTool" });
    expect(created[0].texts).toEqual(["Searching the web…", "Reading 3 results…"]);
    expect(created[0].warnings).toEqual(["one result timed out"]);
  });

  test("marks success with the elapsed time", async () => {
    const created: Recorded[] = [];
    let t = 1000;
    await runWithToolStatus(
      { callId: 1, status: () => {}, warn: () => {} },
      fakeFactory(created),
      async () => {
        t = 1250;
        return "done";
      },
      () => t,
    );
    expect(created[0].states.at(-1)).toEqual({
      type: "toolCallSucceeded",
      timeMs: 250,
    });
  });

  test("marks a thrown error as failed and rethrows it", async () => {
    const created: Recorded[] = [];
    await expect(
      runWithToolStatus(
        { callId: 1, status: () => {}, warn: () => {} },
        fakeFactory(created),
        async () => {
          throw new Error("network down");
        },
        () => 0,
      ),
    ).rejects.toThrow("network down");
    expect(created[0].states.at(-1)).toEqual({
      type: "toolCallFailed",
      error: "network down",
    });
  });

  test("recognizes a capped error result as a failure", async () => {
    // wrapToolsWithCap converts throws into a "Tool execution failed:" result
    // before this layer sees them; the status should still say failed.
    const created: Recorded[] = [];
    const result = await runWithToolStatus(
      { callId: 1, status: () => {}, warn: () => {} },
      fakeFactory(created),
      async () => toolErrorResult("ECONNRESET while fetching"),
      () => 0,
    );
    expect(result).toBe(toolErrorResult("ECONNRESET while fetching"));
    expect(created[0].states.at(-1)).toEqual({
      type: "toolCallFailed",
      error: "ECONNRESET while fetching",
    });
  });

  test("without a callId the tool runs with the original context", async () => {
    const created: Recorded[] = [];
    const original = { status: () => {}, warn: () => {} };
    let seen: unknown;
    await runWithToolStatus(
      original,
      fakeFactory(created),
      async (ctx) => {
        seen = ctx;
        return 1;
      },
      () => 0,
    );
    expect(created).toHaveLength(0);
    expect(seen).toBe(original);
  });

  test("a status that cannot be created or updated never breaks the tool call", async () => {
    for (const throwOn of ["create", "update"] as const) {
      const created: Recorded[] = [];
      const result = await runWithToolStatus(
        { callId: 3, status: () => {}, warn: () => {} },
        fakeFactory(created, { throwOn }),
        async (ctx) => {
          ctx.status("still fine");
          ctx.warn("still fine");
          return "survived";
        },
        () => 0,
      );
      expect(result).toBe("survived");
    }
  });

  test("keeps the original context's signal and callId", async () => {
    const created: Recorded[] = [];
    const controller = new AbortController();
    let seen: { signal?: AbortSignal; callId?: number } | undefined;
    await runWithToolStatus(
      { callId: 9, signal: controller.signal, status: () => {}, warn: () => {} },
      fakeFactory(created),
      async (ctx) => {
        seen = ctx;
        return 1;
      },
      () => 0,
    );
    expect(seen?.signal).toBe(controller.signal);
    expect(seen?.callId).toBe(9);
  });
});
