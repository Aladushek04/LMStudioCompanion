import { describe, expect, test } from "vitest";
import {
  AGENTIC_WORKSPACE_PROTOCOL,
  chunkHasAgenticResults,
  compactAgenticToolResult,
  isAgenticWorkspaceResult,
  renderAgenticToolResultForSummary,
} from "../src/agenticProtocol";
import { CanonMessage } from "../src/view";

function envelope() {
  return {
    protocol: AGENTIC_WORKSPACE_PROTOCOL,
    ok: true,
    operation: "edit.apply",
    summary: "Applied 2 file changes (+20/-4).",
    retention: {
      importance: "critical",
      facts: [
        "transaction tx_abc123 applied",
        "todo_board item_7 completed",
        "source source_primary: https://example.com/spec",
      ],
      omit_when_summarizing: ["data.diffPreview", "data.stdout"],
    },
    artifacts: [
      {
        kind: "diff",
        path: ".agentic/transactions/tx_abc123/changes.diff",
        sha256: "f".repeat(64),
        bytes: 9000,
      },
    ],
    data: {
      transactionId: "tx_abc123",
      status: "applied",
      reviewPath: ".agentic/transactions/tx_abc123/review.md",
      diffPreview: "x".repeat(50_000),
      stdout: "y".repeat(30_000),
      files: [
        { path: "src/a.ts", added: 10, removed: 2 },
        { path: "src/b.ts", added: 10, removed: 2 },
      ],
    },
  };
}

describe("agentic workspace protocol compaction", () => {
  test("detects structured object and JSON-string envelopes", () => {
    expect(isAgenticWorkspaceResult(envelope())).toBe(true);
    expect(isAgenticWorkspaceResult(JSON.stringify(envelope()))).toBe(true);
    expect(isAgenticWorkspaceResult({ protocol: "other" })).toBe(false);
  });

  test("drops declared bulky payloads while retaining recovery state", () => {
    const compact = compactAgenticToolResult(envelope(), 4000) as Record<string, unknown>;
    const text = JSON.stringify(compact);
    expect(text).toContain("tx_abc123");
    expect(text).toContain("transaction tx_abc123 applied");
    expect(text).toContain("review.md");
    expect(text).toContain("changes.diff");
    expect(text).toContain("src/a.ts");
    expect(text).not.toContain("x".repeat(200));
    expect(text).not.toContain("y".repeat(200));
    expect(text).toContain("data.diffPreview");
    expect((compact as Record<string, unknown>).error).toBeUndefined();
  });

  test("preserves task next-actions and command verification fields", () => {
    const value: any = envelope();
    value.data = {
      ...value.data,
      nextActionable: [
        {
          id: "item_next",
          text: "Run the integration test",
          status: "pending",
          priority: "critical",
          dependsOn: ["item_previous"],
        },
      ],
      command: {
        id: "job_verify",
        executable: "npm",
        args: ["test"],
        cwd: ".",
        status: "completed",
        exitCode: 0,
        durationMs: 1234,
      },
    };
    const compact = compactAgenticToolResult(value, 6000);
    const text = JSON.stringify(compact);
    for (const required of [
      "item_next",
      "Run the integration test",
      "critical",
      "item_previous",
      "job_verify",
      "npm",
      "exitCode",
      "1234",
    ]) {
      expect(text).toContain(required);
    }
  });

  test("research.deep keeps the project and the agent run behind its wrappers", () => {
    // workspace_research deep returns { project, agentRun }: two wrapper keys
    // that carry no id prefix of their own. Past the small-object budget the
    // whole subtree used to disappear — state paths, report path, and final
    // result with it.
    const value = {
      protocol: AGENTIC_WORKSPACE_PROTOCOL,
      ok: true,
      operation: "research.deep",
      summary: "Deep research research_7b finished with agent status completed: found stuff",
      retention: {
        importance: "critical",
        facts: ["research project research_7b active: R", "agent run run_22c4 completed"],
        omit_when_summarizing: [
          "data.project.notes",
          "data.project.queries",
          "data.project.sources",
        ],
      },
      data: {
        project: {
          id: "research_7b",
          title: "R",
          // Long enough that the post-omit wrapper is well past the
          // small-object budget the fallback used to require.
          objective: "O".repeat(2600),
          status: "active",
          agentRunId: "run_22c4",
          queryCount: 2,
          sourceCount: 3,
          noteCount: 2,
          queries: [{ id: "query_0", text: "OMITTED QUERY".repeat(20) }],
          sources: [{ id: "source_0", url: "https://example.com/0" }],
          notes: [{ id: "item_0", text: "OMITTED NOTE".repeat(20) }],
          reportPath: ".agentic/research/research_7b/report.md",
          finalSummary: "done",
          createdAt: "2026-08-26T10:00:00.000Z",
          updatedAt: "2026-08-26T10:05:00.000Z",
          statePath: ".agentic/research/research_7b/state.json",
        },
        agentRun: {
          id: "run_22c4",
          status: "completed",
          pass: 2,
          toolCalls: 17,
          final: { summary: "found stuff", evidence: ["a"] },
          statePath: ".agentic/runs/run_22c4/state.json",
          transcriptPath: ".agentic/runs/run_22c4/transcript.ndjson",
        },
      },
    };
    const compact = compactAgenticToolResult(value, 12_000) as Record<string, any>;
    expect(compact.data.project.id).toBe("research_7b");
    expect(compact.data.project.status).toBe("active");
    expect(compact.data.project.reportPath).toBe(".agentic/research/research_7b/report.md");
    expect(compact.data.project.statePath).toBe(".agentic/research/research_7b/state.json");
    expect(compact.data.agentRun.id).toBe("run_22c4");
    expect(compact.data.agentRun.statePath).toBe(".agentic/runs/run_22c4/state.json");
    expect(compact.data.agentRun.transcriptPath).toContain("transcript.ndjson");
    expect(compact.data.agentRun.final.summary).toBe("found stuff");
    // ...and the declared omissions are still gone.
    const text = JSON.stringify(compact);
    expect(text).not.toContain("OMITTED QUERY");
    expect(text).not.toContain("OMITTED NOTE");
  });

  test("an oversized wrapper of unrecognized names keeps its recognized leaves", () => {
    // The general form of the research.deep defect: a wrapper key nobody has
    // taught this module about must not take the ids below it down with it.
    const value = {
      protocol: AGENTIC_WORKSPACE_PROTOCOL,
      ok: true,
      operation: "future.operation",
      summary: "Some future workspace operation.",
      retention: { importance: "high", facts: [] },
      data: {
        somethingNew: {
          id: "tx_deadbe",
          status: "planned",
          statePath: ".agentic/transactions/tx_deadbe/state.json",
          chatter: "z".repeat(2000),
        },
        alsoNew: { id: "run_c0ffee", status: "running", chatter: "z".repeat(2000) },
      },
    };
    const compact = compactAgenticToolResult(value, 12_000) as Record<string, any>;
    expect(compact.data.somethingNew.id).toBe("tx_deadbe");
    expect(compact.data.somethingNew.statePath).toContain("tx_deadbe");
    expect(compact.data.alsoNew.id).toBe("run_c0ffee");
    // The unrecognized leaf is still not worth carrying.
    expect(compact.data.somethingNew.chatter).toBeUndefined();
    expect(JSON.stringify(compact)).not.toContain("z".repeat(200));
  });

  test("preserves input representation for JSON strings", () => {
    const compact = compactAgenticToolResult(JSON.stringify(envelope()), 4000);
    expect(typeof compact).toBe("string");
    const parsed = JSON.parse(compact as string);
    expect(parsed.data.transactionId).toBe("tx_abc123");
  });

  test("summary rendering is bounded and keeps critical IDs", () => {
    const rendered = renderAgenticToolResultForSummary(envelope(), 1200);
    expect(rendered.length).toBeLessThan(1600);
    expect(rendered).toContain("tx_abc123");
    expect(rendered).toContain("changes.diff");
  });

  test("unrelated tool results pass through unchanged", () => {
    const value = { ok: true, data: "x".repeat(100) };
    expect(compactAgenticToolResult(value, 10)).toBe(value);
  });
});

/**
 * The permission gate's staged envelope, built exactly as agentic-workspace's
 * policy/gateRuntime.ts `stagedResult` builds it for the workspace_edit apply
 * gate (src/tools/editTool.ts `transactionGate` + its `extra` thunk): the
 * transaction payload, then `status`/`mode`/`approval` layered on top.
 */
function stagedEditEnvelope(fileCount = 2) {
  const approvalId = "approval_5f2c9d";
  const transactionId = "tx_9a1b4e";
  const resume = {
    tool: "workspace_edit",
    arguments: { action: "commit", transaction_id: transactionId },
  };
  const title = `Commit ${transactionId}`;
  return {
    protocol: AGENTIC_WORKSPACE_PROTOCOL,
    ok: true,
    operation: "edit.apply",
    summary:
      `Awaiting approval ${approvalId}: ${title}. The user must reply /accept ${approvalId} ` +
      `(or /deny ${approvalId} <reason>). After approval, call ${resume.tool} with ` +
      `${JSON.stringify(resume.arguments)}.`,
    retention: {
      importance: "critical",
      facts: [
        `approval ${approvalId} pending: ${title}`,
        "permission mode Manual (0)",
        `transaction ${transactionId} planned`,
      ],
      omit_when_summarizing: ["data.diffPreview"],
    },
    artifacts: [
      {
        kind: "diff",
        path: `.agentic/transactions/${transactionId}/changes.diff`,
        sha256: "a".repeat(64),
        bytes: 7400,
      },
    ],
    data: {
      transactionId,
      // planData()'s own status, overwritten by stagedResult's spread order.
      status: "pending_approval",
      summary: "Rewrite 2 files (+18/-4).",
      destructive: false,
      requiresReview: true,
      addedLines: 18,
      removedLines: 4,
      files: Array.from({ length: fileCount }, (_unused, index) => ({
        path: `src/module${index}.ts`,
        added: 9,
        removed: 2,
        beforeSha256: "b".repeat(64),
        afterSha256: "c".repeat(64),
        beforeExists: true,
        afterExists: true,
        beforeSnapshotPath: `.agentic/transactions/${transactionId}/snapshots/before-${index}`,
        afterSnapshotPath: `.agentic/transactions/${transactionId}/snapshots/after-${index}`,
      })),
      diffPath: `.agentic/transactions/${transactionId}/changes.diff`,
      reviewPath: `.agentic/transactions/${transactionId}/review.md`,
      diffPreview: "d".repeat(40_000),
      diffTruncated: true,
      diffOmittedChars: 31_000,
      committed: false,
      mode: "manual",
      approval: {
        id: approvalId,
        kind: "transaction",
        title,
        destructive: false,
        resume,
      },
    },
  };
}

/**
 * The same staged shape for any gated tool: the tool's own data, then
 * `status`/`mode`/`approval` layered on top, with the resume call spelled into
 * the summary exactly as `stagedResult` spells it.
 */
function stagedEnvelope(options: {
  operation: string;
  approvalId: string;
  kind: string;
  title: string;
  resume: { tool: string; arguments: Record<string, unknown> };
  data?: Record<string, unknown>;
}) {
  const { operation, approvalId, kind, title, resume, data } = options;
  return {
    protocol: AGENTIC_WORKSPACE_PROTOCOL,
    ok: true,
    operation,
    summary:
      `Awaiting approval ${approvalId}: ${title}. The user must reply /accept ${approvalId} ` +
      `(or /deny ${approvalId} <reason>). After approval, call ${resume.tool} with ` +
      `${JSON.stringify(resume.arguments)}.`,
    retention: {
      importance: "critical",
      facts: [`approval ${approvalId} pending: ${title}`, "permission mode Manual (0)"],
    },
    data: {
      ...(data ?? {}),
      status: "pending_approval",
      mode: "manual",
      approval: { id: approvalId, kind, title, destructive: false, resume },
    },
  };
}

/**
 * `runtime.processes.list(limit)` entries as workspace_inspect changes embeds
 * them: the verbatim `CommandJobSummary` records from agentic-workspace's
 * execution/processRunner.ts — id, status, executable, an optional exitCode
 * (absent while the job runs), startedAt.
 *
 * Twenty of them, because that is the producer's default `limit` and also the
 * compressor's generic array cap: a full listing has to arrive whole, not
 * twenty-of-twenty-one with the newest job's id replaced by a counter.
 */
function commandJobs() {
  return Array.from({ length: 20 }, (_unused, index) => {
    const status = index === 0 ? "running" : index === 1 ? "orphaned" : "exited";
    return {
      id: `job_${(index + 1).toString(16).padStart(4, "0")}`,
      status,
      executable: index % 2 === 0 ? "npm" : "git",
      ...(status === "exited" ? { exitCode: index % 3 === 0 ? 0 : 1 } : {}),
      startedAt: `2026-08-26T09:${(40 + index).toString().padStart(2, "0")}:00.000Z`,
    };
  });
}

/**
 * workspace_inspect changes — the post-compaction recovery index, built as
 * agentic-workspace's src/tools/workspaceTool.ts builds it.
 *
 * The producer's own omit list is the four bulky arrays (transactions, runs,
 * taskBoards, researchProjects); `jobs`, `approvals` and `plans` are the small
 * recovery index and are deliberately left out of it. `omitBulky` here
 * over-declares on purpose — it adds approvals and plans — so the pair of
 * shapes proves two different things: that a declared omission is honoured,
 * and that `jobs`, declared omittable by neither shape, survives both.
 */
function changesEnvelope(omitBulky = true) {
  const jobs = commandJobs();
  return {
    protocol: AGENTIC_WORKSPACE_PROTOCOL,
    ok: true,
    operation: "workspace.changes",
    summary:
      `Found 1 transaction(s), 0 agent run(s), ${jobs.length} command job(s), 0 task board(s), ` +
      "0 research project(s), 1 approval(s), and 1 plan(s).",
    retention: {
      importance: "high",
      facts: [
        "tx_9a1b4e previewed",
        ...jobs.slice(0, 5).map((job) => `${job.id} ${job.status} ${job.executable}`),
        "approval_5f2c9d pending",
        "plan_7c1f22 approved",
      ],
      ...(omitBulky
        ? {
            omit_when_summarizing: [
              "data.transactions",
              "data.runs",
              "data.taskBoards",
              "data.researchProjects",
              "data.approvals",
              "data.plans",
            ],
          }
        : {}),
    },
    data: {
      transactions: [
        {
          id: "tx_9a1b4e",
          status: "previewed",
          summary: "Rewrite 2 files (+18/-4).",
          fileCount: 2,
          files: ["src/module0.ts", "src/module1.ts"],
          filesTruncated: false,
          updatedAt: "2026-08-26T10:00:00.000Z",
          diffPath: ".agentic/transactions/tx_9a1b4e/changes.diff",
          reviewPath: ".agentic/transactions/tx_9a1b4e/review.md",
        },
      ],
      runs: [],
      jobs,
      taskBoards: [],
      researchProjects: [],
      approvals: [
        {
          id: "approval_5f2c9d",
          kind: "transaction",
          status: "pending",
          title: "Commit tx_9a1b4e",
          updatedAt: "2026-08-26T10:00:00.000Z",
        },
      ],
      plans: [
        {
          id: "plan_7c1f22",
          status: "approved",
          title: "Wire the approval gate through compaction",
          revision: 2,
          planPath: ".agentic/plans/plan_7c1f22/plan.md",
        },
      ],
    },
  };
}

describe("staged approvals and plans", () => {
  test("keeps the pending status, mode, and the exact resume call", () => {
    const compact = compactAgenticToolResult(stagedEditEnvelope(), 12_000) as Record<
      string,
      any
    >;
    expect(compact.data.status).toBe("pending_approval");
    expect(compact.data.mode).toBe("manual");
    expect(compact.data.approval.id).toBe("approval_5f2c9d");
    expect(compact.data.approval.kind).toBe("transaction");
    expect(compact.data.approval.title).toBe("Commit tx_9a1b4e");
    expect(compact.data.approval.destructive).toBe(false);
    expect(compact.data.approval.resume.tool).toBe("workspace_edit");
    // Every argument survives, including the ones no key rule recognizes:
    // a resume call missing its action is not a call.
    expect(compact.data.approval.resume.arguments).toEqual({
      action: "commit",
      transaction_id: "tx_9a1b4e",
    });
    // ...while the payload the plugin declared bulky still goes.
    expect(compact.data.diffPreview).toBeUndefined();
    expect(JSON.stringify(compact)).not.toContain("d".repeat(200));
  });

  test("keeps the approval when the compacted envelope still overflows", () => {
    const compact = compactAgenticToolResult(stagedEditEnvelope(40), 1500) as Record<
      string,
      any
    >;
    const text = JSON.stringify(compact);
    expect(text.length).toBeGreaterThan(0);
    expect(compact.data.preservedRecoveryFields).toBeDefined();
    expect(compact.data.status).toBe("pending_approval");
    expect(compact.data.approval.id).toBe("approval_5f2c9d");
    expect(compact.data.approval.resume.arguments.transaction_id).toBe("tx_9a1b4e");
  });

  test("keeps a large resume argument object verbatim, key for key", () => {
    // workspace_browser control: 30 queued actions, ~3.8 KB of arguments. The
    // model must re-issue the batch byte for byte — the staged approval's
    // operation hash is taken over exactly these arguments.
    const actions = Array.from({ length: 30 }, (_unused, index) => ({
      type: "type",
      selector: `#field${index}`,
      value: "v".repeat(80),
    }));
    const args = { action: "control", session_id: "sess_1", actions };
    expect(JSON.stringify(args).length).toBeGreaterThan(3000);
    const compact = compactAgenticToolResult(
      stagedEnvelope({
        operation: "browser.control",
        approvalId: "approval_b1c2d3",
        kind: "browser",
        title: "Browser control on sess_1 (30 action(s))",
        resume: { tool: "workspace_browser", arguments: args },
      }),
      12_000,
    ) as Record<string, any>;
    expect(compact.data.approval.resume.tool).toBe("workspace_browser");
    expect(compact.data.approval.resume.arguments).toEqual(args);
  });

  test("keeps long resume argument strings byte-identical", () => {
    // workspace_command run with piped stdin: compacting the string would
    // splice a "chars omitted" marker into the input the command receives.
    const input = "line of input\n".repeat(140);
    const args = { action: "run", executable: "node", args: ["-"], input, timeout_seconds: 60 };
    const compact = compactAgenticToolResult(
      stagedEnvelope({
        operation: "command.run",
        approvalId: "approval_c4d5e6",
        kind: "command",
        title: "Run node -",
        resume: { tool: "workspace_command", arguments: args },
      }),
      12_000,
    ) as Record<string, any>;
    const kept = compact.data.approval.resume.arguments.input as string;
    expect(kept).toBe(input);
    expect(kept).not.toContain("chars omitted");
    expect(compact.data.approval.resume.arguments).toEqual(args);
  });

  test("drops an oversized resume wholesale rather than emitting a partial call", () => {
    const marker = "PAYLOAD ".repeat(2000);
    const args = { action: "write", path: "src/generated.ts", content: marker };
    expect(JSON.stringify(args).length).toBeGreaterThan(12_000);
    const compact = compactAgenticToolResult(
      stagedEnvelope({
        operation: "edit.apply",
        approvalId: "approval_f7a8b9",
        kind: "transaction",
        title: "Write src/generated.ts",
        resume: { tool: "workspace_edit", arguments: args },
      }),
      12_000,
    ) as Record<string, any>;
    // The approval itself still resolves; only the call is gone, and gone
    // whole — no half-populated arguments the model could re-issue.
    expect(compact.data.status).toBe("pending_approval");
    expect(compact.data.approval.id).toBe("approval_f7a8b9");
    expect(compact.data.approval.title).toBe("Write src/generated.ts");
    expect(compact.data.approval.resume.arguments).toBeUndefined();
    expect(compact.data.approval.resume.tool).toBeUndefined();
    expect(compact.data.approval.resume.omitted).toBe("arguments_too_large");
    expect(compact.data.approval.resume.note).toContain("workspace_inspect");
    expect(JSON.stringify(compact.data)).not.toContain("PAYLOAD PAYLOAD");
  });

  test("keeps the web gate kind on a staged research egress", () => {
    // research.search stages through gateEgress (agentic-workspace
    // src/tools/researchTool.ts) with kind "web" — network egress, not a file
    // mutation — and resumes with the same workspace_research call. `kind` is
    // what tells the model which ceiling blocked it, and therefore what to say
    // to the user; the transaction and browser kinds are pinned above, this
    // pins the newest one on both the normal and the overflow path.
    const args = {
      action: "search",
      query: "lm studio plugin prediction loop handler",
      provider: "duckduckgo",
      max_results: 5,
    };
    const staged = () =>
      stagedEnvelope({
        operation: "research.search",
        approvalId: "approval_9e0f11",
        kind: "web",
        title: `Web search: ${args.query}`,
        resume: { tool: "workspace_research", arguments: args },
      });
    const compact = compactAgenticToolResult(staged(), 12_000) as Record<string, any>;
    expect(compact.data.status).toBe("pending_approval");
    expect(compact.data.approval.kind).toBe("web");
    expect(compact.data.approval.id).toBe("approval_9e0f11");
    expect(compact.data.approval.title).toContain("Web search:");
    expect(compact.data.approval.resume.tool).toBe("workspace_research");
    expect(compact.data.approval.resume.arguments).toEqual(args);
    // The approval object is kept wholesale when the envelope overflows too,
    // so the kind cannot be lost to the bounded record scan.
    const overflowed = compactAgenticToolResult(staged(), 800) as Record<string, any>;
    expect(overflowed.data.approval.kind).toBe("web");
    expect(overflowed.data.approval.id).toBe("approval_9e0f11");
  });

  test("summary rendering carries the approval id and the /accept instruction", () => {
    const rendered = renderAgenticToolResultForSummary(stagedEditEnvelope(), 4000);
    expect(rendered).toContain("approval_5f2c9d");
    expect(rendered).toContain("/accept approval_5f2c9d");
    expect(rendered).toContain("workspace_edit");
    expect(rendered).toContain("tx_9a1b4e");
  });

  test("capabilities keeps the permission mode, active plan, and pending count", () => {
    // Abridged workspace_inspect capabilities data (no omit list there).
    const value = {
      protocol: AGENTIC_WORKSPACE_PROTOCOL,
      ok: true,
      operation: "workspace.capabilities",
      summary:
        "Agentic Workspace is active with transactional edits and compact artifact-backed results.",
      retention: {
        importance: "high",
        facts: ["permission mode Plan (1)"],
      },
      data: {
        workspace: "C:/work/repo",
        permissionMode: "plan",
        permissionLevel: 1,
        activePlan: { id: "plan_7c1f22", title: "Wire the approval gate through compaction" },
        pendingPlan: null,
        pendingApprovals: 2,
        resultProtocol: "agentic-workspace/v1",
      },
    };
    const compact = compactAgenticToolResult(value, 12_000) as Record<string, any>;
    expect(compact.data.permissionMode).toBe("plan");
    expect(compact.data.activePlan.id).toBe("plan_7c1f22");
    expect(compact.data.activePlan.title).toContain("approval gate");
    expect(compact.data.pendingPlan).toBeNull();
    expect(compact.data.pendingApprovals).toBe(2);
  });

  test("overview keeps the root, memory, and every recent* durable id", () => {
    // workspace_inspect overview: the first call of a resumed chat, and the
    // only place the model sees the ids it can recover state with.
    const value = {
      protocol: AGENTIC_WORKSPACE_PROTOCOL,
      ok: true,
      operation: "workspace.overview",
      summary:
        "Workspace overview: 2 entries, 1 transaction(s), 1 agent run(s), 1 task board(s), 1 research project(s).",
      retention: {
        importance: "high",
        facts: ["workspace root C:/work/repo"],
        omit_when_summarizing: ["data.tree.entries"],
      },
      data: {
        root: "C:/work/repo",
        tree: {
          root: ".",
          entries: [{ path: "src", type: "directory" }],
          truncated: false,
          entryCount: 2,
        },
        activePlan: { id: "plan_7c1f22", title: "Wire the approval gate" },
        pendingPlan: null,
        pendingApprovals: 1,
        memory: { exists: true, path: ".agentic/MEMORY.md", bytes: 420 },
        noteCount: 3,
        recentTransactions: [
          {
            id: "tx_9a1b4e",
            status: "applied",
            summary: "edit 2 files",
            updatedAt: "2026-08-26T10:00:00.000Z",
            reviewPath: ".agentic/transactions/tx_9a1b4e/review.md",
          },
        ],
        recentRuns: [
          {
            id: "run_22c4",
            status: "completed",
            mode: "coding",
            objective: "do the thing",
            taskBoardId: "todo_5e",
            updatedAt: "2026-08-26T10:00:00.000Z",
          },
        ],
        recentTaskBoards: [
          {
            id: "todo_5e",
            status: "active",
            title: "Board",
            itemCount: 4,
            completedCount: 1,
            nextActionable: [{ id: "item_9f", text: "next thing", priority: "high" }],
            updatedAt: "2026-08-26T10:00:00.000Z",
            statePath: ".agentic/tasks/todo_5e/state.json",
          },
        ],
        recentResearchProjects: [
          {
            id: "research_7b",
            status: "active",
            title: "R",
            agentRunId: "run_22c4",
            queryCount: 2,
            sourceCount: 5,
            reportPath: ".agentic/research/research_7b/report.md",
            updatedAt: "2026-08-26T10:00:00.000Z",
            statePath: ".agentic/research/research_7b/state.json",
          },
        ],
      },
    };
    const compact = compactAgenticToolResult(value, 12_000) as Record<string, any>;
    expect(compact.data.root).toBe("C:/work/repo");
    expect(compact.data.memory.path).toBe(".agentic/MEMORY.md");
    expect(compact.data.recentTransactions[0].id).toBe("tx_9a1b4e");
    expect(compact.data.recentTransactions[0].reviewPath).toContain("review.md");
    expect(compact.data.recentRuns[0]).toMatchObject({
      id: "run_22c4",
      status: "completed",
      taskBoardId: "todo_5e",
    });
    expect(compact.data.recentTaskBoards[0].id).toBe("todo_5e");
    expect(compact.data.recentTaskBoards[0].nextActionable[0].id).toBe("item_9f");
    expect(compact.data.recentTaskBoards[0].statePath).toContain("todo_5e");
    expect(compact.data.recentResearchProjects[0].id).toBe("research_7b");
    expect(compact.data.recentResearchProjects[0].reportPath).toContain("report.md");
    expect(compact.data.activePlan.id).toBe("plan_7c1f22");
    expect(compact.data.pendingApprovals).toBe(1);
  });

  test("changes keeps approval and plan entries with ids and statuses", () => {
    // The recovery index as it arrives when its arrays are not declared
    // omittable — every entry is an id/status record, none of it bulky.
    const compact = compactAgenticToolResult(changesEnvelope(false), 12_000) as Record<
      string,
      any
    >;
    expect(compact.data.approvals[0]).toMatchObject({
      id: "approval_5f2c9d",
      kind: "transaction",
      status: "pending",
      title: "Commit tx_9a1b4e",
    });
    expect(compact.data.plans[0]).toMatchObject({
      id: "plan_7c1f22",
      status: "approved",
      revision: 2,
      planPath: ".agentic/plans/plan_7c1f22/plan.md",
    });
    expect(compact.data.transactions[0].id).toBe("tx_9a1b4e");
  });

  test("changes keeps every command job id, status, and exit code", () => {
    // workspace_inspect changes grew a `jobs` array (agentic-workspace
    // src/tools/workspaceTool.ts): five short fields per background command,
    // capped at the listing limit, and the only route back to a `job_` id
    // after compaction — the workflow hint promises exactly that recovery, so
    // the producer keeps it out of omit_when_summarizing. It has to survive
    // whichever way the rest of the index is declared.
    const expected = commandJobs();
    for (const omitBulky of [false, true]) {
      const compact = compactAgenticToolResult(changesEnvelope(omitBulky), 12_000) as Record<
        string,
        any
      >;
      const jobs = compact.data.jobs as Array<Record<string, unknown>>;
      // Field for field, not just "some of them": a job whose exitCode was
      // dropped reads as still running.
      expect(jobs).toEqual(expected);
      expect(jobs.map((job) => job.id)).toEqual(expected.map((job) => job.id));
      expect(jobs.map((job) => job.status)).toEqual(expected.map((job) => job.status));
      // No entry traded for an `{ omittedItems: n }` counter, and nothing
      // walked the array back in as a declared omission.
      expect(JSON.stringify(jobs)).not.toContain("omittedItems");
      expect(compact.retention.omittedPayloads ?? []).not.toContain("data.jobs");
    }
  });

  test("changes still honours omit_when_summarizing, ids surviving in facts", () => {
    const compact = compactAgenticToolResult(changesEnvelope(true), 12_000) as Record<
      string,
      any
    >;
    expect(compact.data?.approvals).toBeUndefined();
    expect(compact.data?.plans).toBeUndefined();
    expect(compact.retention.omittedPayloads).toContain("data.approvals");
    expect(compact.retention.omittedPayloads).toContain("data.plans");
    expect(compact.retention.facts).toContain("approval_5f2c9d pending");
    expect(compact.retention.facts).toContain("plan_7c1f22 approved");
  });

  test("plan.propose keeps the plan id and path while dropping omitted bulk", () => {
    const value = {
      protocol: AGENTIC_WORKSPACE_PROTOCOL,
      ok: true,
      operation: "plan.propose",
      summary:
        "Plan plan_7c1f22 proposed (2 step(s)): Wire the approval gate through compaction. " +
        "Restate it to the user verbatim and stop; mutating tools stay locked until the user " +
        "replies /accept plan_7c1f22 (or /deny plan_7c1f22 <reason>).",
      retention: {
        importance: "critical",
        facts: [
          "plan plan_7c1f22 pending approval: Wire the approval gate through compaction",
          "permission mode Plan (1)",
          "step 1: teach agenticProtocol the approval keys",
        ],
        omit_when_summarizing: ["data.markdown", "data.plan.steps"],
      },
      artifacts: [
        {
          kind: "text",
          path: ".agentic/plans/plan_7c1f22/plan.md",
          sha256: "e".repeat(64),
          bytes: 1200,
          description: "Plan plan_7c1f22: Wire the approval gate through compaction",
        },
      ],
      data: {
        planId: "plan_7c1f22",
        status: "pending",
        revision: 2,
        supersedes: "plan_001aaa",
        title: "Wire the approval gate through compaction",
        plan: {
          title: "Wire the approval gate through compaction",
          objective: "Preserve staged approvals across compaction.",
          steps: [
            { n: 1, text: "s".repeat(1500), kind: "edit" },
            { n: 2, text: "s".repeat(1500), kind: "edit" },
          ],
          files: [{ path: "src/agenticProtocol.ts", change: "modify" }],
          commands: [{ executable: "npm", args: ["run", "check"] }],
          risks: [],
          questions: [],
          revision: 2,
        },
        planPath: ".agentic/plans/plan_7c1f22/plan.md",
        markdown: "m".repeat(20_000),
        instruction:
          "Restate this plan to the user verbatim, then stop. Do not call mutating tools until the user replies /accept plan_7c1f22.",
      },
    };
    const compact = compactAgenticToolResult(value, 12_000) as Record<string, any>;
    expect(compact.data.planId).toBe("plan_7c1f22");
    expect(compact.data.status).toBe("pending");
    expect(compact.data.revision).toBe(2);
    expect(compact.data.supersedes).toBe("plan_001aaa");
    expect(compact.data.planPath).toBe(".agentic/plans/plan_7c1f22/plan.md");
    expect(compact.data.instruction).toContain("/accept plan_7c1f22");
    // The explicitly omitted payloads stay gone.
    expect(compact.data.markdown).toBeUndefined();
    expect(compact.data.plan?.steps).toBeUndefined();
    expect(JSON.stringify(compact)).not.toContain("s".repeat(200));
    expect(JSON.stringify(compact)).not.toContain("m".repeat(200));
  });
});

/** A minimal envelope wrapper for shape-level assertions. */
function operationEnvelope(
  operation: string,
  summary: string,
  data: unknown,
  retention: Record<string, unknown> = { importance: "normal" },
) {
  return {
    protocol: AGENTIC_WORKSPACE_PROTOCOL,
    ok: true,
    operation,
    summary,
    retention,
    data,
  };
}

describe("recovery fields the model reasons with", () => {
  test("keeps the directories a mkdir-only transaction created", () => {
    // workspace_edit list / workspace_inspect changes share this entry shape.
    // With `directories` gone the entry read "0 files, 2 directories" and did
    // not say which two.
    const compact = compactAgenticToolResult(
      operationEnvelope(
        "edit.list",
        "Listed 1 transaction(s).",
        [
          {
            transactionId: "tx_9a1b4e",
            destructive: false,
            requiresReview: false,
            addedLines: 0,
            removedLines: 0,
            status: "planned",
            summary: "scaffold",
            fileCount: 0,
            files: [],
            filesTruncated: false,
            directoryCount: 2,
            directories: ["src/new", "docs"],
            directoriesTruncated: false,
            updatedAt: "2026-08-26T10:00:00.000Z",
            diffPath: ".agentic/transactions/tx_9a1b4e/changes.diff",
            reviewPath: ".agentic/transactions/tx_9a1b4e/review.md",
          },
        ],
        { importance: "high", facts: ["tx_9a1b4e planned"] },
      ),
      12_000,
    ) as Record<string, any>;
    const entry = compact.data[0];
    expect(entry.transactionId).toBe("tx_9a1b4e");
    expect(entry.directoryCount).toBe(2);
    expect(entry.directories).toEqual(["src/new", "docs"]);
    expect(entry.directoriesTruncated).toBe(false);
    expect(entry.filesTruncated).toBe(false);
    expect(entry.addedLines).toBe(0);
    expect(entry.removedLines).toBe(0);
  });

  test("keeps the capability flags the model plans around", () => {
    const compact = compactAgenticToolResult(
      operationEnvelope(
        "workspace.capabilities",
        "Agentic Workspace is active with transactional edits and compact artifact-backed results.",
        {
          workspace: "C:/work/repo",
          permissionMode: "plan",
          permissionLevel: 1,
          activePlan: { id: "plan_7c1f22", title: "Wire the approval gate" },
          pendingPlan: null,
          pendingApprovals: 0,
          notes: { count: 2, memoryExists: true, memoryPath: ".agentic/MEMORY.md" },
          destructiveCommits: false,
          processExecution: true,
          durableAgents: true,
          taskBoards: true,
          webResearch: true,
          webSearchProvider: "duckduckgo",
          agentWebAccess: true,
          gitAndGitHub: true,
          browserAutomation: false,
          tools: ["workspace_inspect", "workspace_edit", "workspace_plan"],
          resultProtocol: "agentic-workspace/v1",
          storage: {
            root: ".agentic/",
            transactions: ".agentic/transactions/",
            plans: ".agentic/plans/",
            approvals: ".agentic/approvals/",
            memory: ".agentic/MEMORY.md",
          },
          editVisibility: {
            diff: ".agentic/transactions/<id>/changes.diff",
            reviewReceipt: ".agentic/transactions/<id>/review.md",
            snapshots: ".agentic/transactions/<id>/snapshots/",
          },
        },
        { importance: "high", facts: ["permission mode Plan (1)"] },
      ),
      12_000,
    ) as Record<string, any>;
    expect(compact.data.workspace).toBe("C:/work/repo");
    expect(compact.data.permissionLevel).toBe(1);
    expect(compact.data.notes.memoryPath).toBe(".agentic/MEMORY.md");
    expect(compact.data.destructiveCommits).toBe(false);
    expect(compact.data.processExecution).toBe(true);
    expect(compact.data.durableAgents).toBe(true);
    expect(compact.data.webResearch).toBe(true);
    expect(compact.data.webSearchProvider).toBe("duckduckgo");
    expect(compact.data.agentWebAccess).toBe(true);
    expect(compact.data.gitAndGitHub).toBe(true);
    expect(compact.data.browserAutomation).toBe(false);
    expect(compact.data.tools).toContain("workspace_plan");
    expect(compact.data.storage.plans).toBe(".agentic/plans/");
    expect(compact.data.editVisibility.diff).toContain("changes.diff");
  });

  test("keeps a sub-agent run's gate state and remaining budget", () => {
    // A sub-agent carries `commitEdits` instead of a permission mode: it is
    // the whole answer to "will this run's edits land?".
    const compact = compactAgenticToolResult(
      operationEnvelope(
        "agent.status",
        "run_22c4: completed — did the thing",
        {
          id: "run_22c4",
          status: "completed",
          objective: "do the thing",
          role: "coding agent",
          modelId: "qwen3",
          mode: "coding",
          commitEdits: false,
          allowCommands: true,
          allowWeb: false,
          taskBoardId: "todo_5e",
          pass: 2,
          maxPasses: 4,
          toolCalls: 17,
          maxToolCalls: 60,
          plan: [{ n: 1, text: "p", status: "done" }],
          filesRead: [{ path: "src/a.ts", sha256: "a".repeat(64) }],
          filesChanged: ["src/a.ts"],
          transactions: ["tx_9a1b4e"],
          commands: [{ id: "job_1d", summary: "npm test -> 0" }],
          sources: [],
          notes: ["n"],
          final: { summary: "did the thing", evidence: ["tests pass"] },
          createdAt: "2026-08-26T10:00:00.000Z",
          updatedAt: "2026-08-26T10:05:00.000Z",
          startedAt: "2026-08-26T10:00:00.000Z",
          finishedAt: "2026-08-26T10:05:00.000Z",
          statePath: ".agentic/runs/run_22c4/state.json",
          transcriptPath: ".agentic/runs/run_22c4/transcript.ndjson",
        },
        {
          importance: "critical",
          facts: ["run_22c4 completed"],
          omit_when_summarizing: ["data.notes", "data.plan"],
        },
      ),
      12_000,
    ) as Record<string, any>;
    expect(compact.data.commitEdits).toBe(false);
    expect(compact.data.allowCommands).toBe(true);
    expect(compact.data.allowWeb).toBe(false);
    expect(compact.data.role).toBe("coding agent");
    expect(compact.data.pass).toBe(2);
    expect(compact.data.maxPasses).toBe(4);
    expect(compact.data.toolCalls).toBe(17);
    expect(compact.data.maxToolCalls).toBe(60);
    expect(compact.data.filesRead[0].path).toBe("src/a.ts");
    expect(compact.data.transactions).toEqual(["tx_9a1b4e"]);
  });

  test("keeps an approved plan's file changes, risks, and open questions", () => {
    const compact = compactAgenticToolResult(
      operationEnvelope(
        "plan.show",
        "plan_7c1f22: Wire the approval gate (approved).",
        {
          planId: "plan_7c1f22",
          status: "approved",
          revision: 2,
          title: "Wire the approval gate",
          plan: {
            title: "Wire the approval gate",
            objective: "Preserve staged approvals across compaction.",
            steps: [{ n: 1, text: "s".repeat(1500), kind: "edit" }],
            files: [
              { path: "src/agenticProtocol.ts", change: "modify" },
              { path: "src/legacyProtocol.ts", change: "delete" },
              { path: "tests/new.test.ts", change: "create" },
            ],
            commands: [{ executable: "npm", args: ["run", "check"] }],
            risks: ["may break cached summaries"],
            questions: ["which branch does this land on?"],
            revision: 2,
          },
          planPath: ".agentic/plans/plan_7c1f22/plan.md",
        },
        {
          importance: "critical",
          facts: ["plan plan_7c1f22 approved"],
          omit_when_summarizing: ["data.plan.steps"],
        },
      ),
      12_000,
    ) as Record<string, any>;
    expect(compact.data.plan.files).toEqual([
      { path: "src/agenticProtocol.ts", change: "modify" },
      { path: "src/legacyProtocol.ts", change: "delete" },
      { path: "tests/new.test.ts", change: "create" },
    ]);
    expect(compact.data.plan.risks).toEqual(["may break cached summaries"]);
    expect(compact.data.plan.questions).toEqual(["which branch does this land on?"]);
    expect(compact.data.plan.steps).toBeUndefined();
  });

  test("keeps the counters that say how much was hidden", () => {
    // research.fetch: the page text and links are declared omittable, so
    // `truncated` / `linksOmitted` / `bytes` are all that is left to tell the
    // model whether what it did see was the whole page.
    const compact = compactAgenticToolResult(
      operationEnvelope(
        "research.fetch",
        "source_1a: Title",
        {
          researchProjectId: "research_7b",
          sourceId: "source_1a",
          url: "https://example.com/1",
          title: "Title",
          status: 200,
          fetchedAt: "2026-08-26T10:00:00.000Z",
          contentType: "text/html",
          bytes: 5000,
          sha256: "f".repeat(64),
          truncated: true,
          contentPath: ".agentic/research/research_7b/sources/source_1a.txt",
          text: "page text ".repeat(50),
          links: [{ href: "https://example.com/y", text: "y" }],
          linksOmitted: 173,
        },
        {
          importance: "critical",
          facts: ["source source_1a: https://example.com/1"],
          omit_when_summarizing: ["data.text", "data.links"],
        },
      ),
      12_000,
    ) as Record<string, any>;
    expect(compact.data.truncated).toBe(true);
    expect(compact.data.linksOmitted).toBe(173);
    expect(compact.data.contentType).toBe("text/html");
    expect(compact.data.bytes).toBe(5000);
    expect(compact.data.text).toBeUndefined();
  });

  test("keeps command output sizes and the resolved executable", () => {
    const compact = compactAgenticToolResult(
      operationEnvelope(
        "command.status",
        "job_3c: running.",
        {
          id: "job_3c",
          status: "running",
          executable: "npm",
          resolvedExecutable: "C:/Program Files/nodejs/node.exe",
          resolvedScript: "C:/work/repo/node_modules/npm/bin/npm-cli.js",
          args: ["run", "dev"],
          cwd: "C:/work/repo",
          startedAt: "2026-08-26T10:00:00.000Z",
          durationMs: 1200,
          timedOut: false,
          stdout: "s".repeat(4000),
          stderr: "",
          stdoutBytes: 900_000,
          stderrBytes: 0,
          stdoutCapturedBytes: 262_144,
          stderrCapturedBytes: 0,
          stdoutTruncated: true,
          stderrTruncated: false,
          stdoutTail: "t".repeat(1000),
          stderrTail: "",
        },
        {
          importance: "high",
          facts: ["job_3c running"],
          omit_when_summarizing: [
            "data.stdout",
            "data.stderr",
            "data.stdoutTail",
            "data.stderrTail",
          ],
        },
      ),
      12_000,
    ) as Record<string, any>;
    expect(compact.data.stdoutBytes).toBe(900_000);
    expect(compact.data.stdoutCapturedBytes).toBe(262_144);
    expect(compact.data.stderrBytes).toBe(0);
    expect(compact.data.resolvedExecutable).toContain("node.exe");
    expect(compact.data.resolvedScript).toContain("npm-cli.js");
    expect(compact.data.stdoutTruncated).toBe(true);
    expect(compact.data.stdout).toBeUndefined();
  });

  test("keeps a note's name and a stat entry's type and mtime", () => {
    const note = compactAgenticToolResult(
      operationEnvelope(
        "notes.read",
        "Read note plan-notes (900 bytes).",
        {
          name: "plan-notes",
          path: ".agentic/notes/plan-notes.md",
          content: "x".repeat(900),
          bytes: 900,
        },
        {
          importance: "high",
          facts: ["note plan-notes at .agentic/notes/plan-notes.md (900 bytes)"],
          omit_when_summarizing: ["data.content"],
        },
      ),
      12_000,
    ) as Record<string, any>;
    expect(note.data.name).toBe("plan-notes");
    expect(note.data.content).toBeUndefined();

    const stat = compactAgenticToolResult(
      operationEnvelope("workspace.stat", "src/index.ts: file, 4210 bytes.", {
        path: "src/index.ts",
        type: "file",
        bytes: 4210,
        modifiedAt: "2026-08-26T10:00:00.000Z",
        sha256: "a".repeat(64),
      }),
      12_000,
    ) as Record<string, any>;
    expect(stat.data.type).toBe("file");
    expect(stat.data.modifiedAt).toBe("2026-08-26T10:00:00.000Z");
  });

  test("keeps the total behind a paged listing", () => {
    const compact = compactAgenticToolResult(
      operationEnvelope(
        "agent.history",
        "Loaded 3 of 40 event(s) for run_22c4.",
        { runId: "run_22c4", total: 40, events: [{ at: "t", summary: "read file" }] },
        {
          importance: "normal",
          facts: ["read file"],
          omit_when_summarizing: ["data.events"],
        },
      ),
      12_000,
    ) as Record<string, any>;
    expect(compact.data.runId).toBe("run_22c4");
    expect(compact.data.total).toBe(40);
  });
});

describe("overflow path", () => {
  /** workspace_search: the matches are bulk, and declared so. */
  function searchEnvelope(matchCount = 40) {
    const matches = Array.from({ length: matchCount }, (_unused, index) => ({
      path: `src/f${index}.ts`,
      line: index,
      text: `SECRET MATCH LINE ${index} ${"z".repeat(120)}`,
    }));
    return {
      protocol: AGENTIC_WORKSPACE_PROTOCOL,
      ok: true,
      operation: "workspace.search",
      summary: `Found ${matchCount} match(es) across 100 scanned file(s).`,
      retention: {
        importance: "normal",
        facts: matches.slice(0, 10).map((match) => `${match.path}:${match.line}`),
        omit_when_summarizing: ["data.matches"],
      },
      data: { query: "token", filesScanned: 100, matches },
    };
  }

  test("never walks a declared omission back in", () => {
    // The record scan used to run on the original data rather than the
    // omit-stripped clone, so shrinking the cap put the omitted payload back.
    for (const cap of [12_000, 2000, 500, 300]) {
      const text = JSON.stringify(compactAgenticToolResult(searchEnvelope(), cap));
      expect(text).not.toContain("SECRET MATCH LINE");
      expect(text).not.toContain("z".repeat(200));
    }
  });

  test("does not grow past the cap it was given", () => {
    // At cap 300 the unbounded record list produced 5218 bytes of output.
    const compact = compactAgenticToolResult(searchEnvelope(), 300) as Record<string, any>;
    const text = JSON.stringify(compact);
    expect(text.length).toBeLessThan(1000);
    // The ids and paths still reach the summarizer through the facts.
    expect(compact.retention.facts).toContain("src/f0.ts:0");
    expect(compact.data.note).toContain("Agentic Workspace tools");
  });

  test("spends the remaining budget on recovery fields when there is one", () => {
    // research.show with a long source ledger: the ledger is not declared
    // omittable, so the envelope overflows on content worth preserving.
    const value = {
      protocol: AGENTIC_WORKSPACE_PROTOCOL,
      ok: true,
      operation: "research.show",
      summary: "research_7b: R (active).",
      retention: {
        importance: "critical",
        facts: ["research project research_7b active: R"],
        omit_when_summarizing: ["data.notes", "data.queries"],
      },
      data: {
        id: "research_7b",
        title: "R",
        objective: "Ship X",
        status: "active",
        agentRunId: "run_22c4",
        queryCount: 12,
        sourceCount: 70,
        queries: Array.from({ length: 12 }, (_unused, index) => ({
          id: `query_${index}`,
          text: `OMITTED QUERY TEXT ${index} ${"q".repeat(150)}`,
        })),
        sources: Array.from({ length: 70 }, (_unused, index) => ({
          id: `source_${index}`,
          url: `https://example.com/very/long/path/segment/${index}`,
          title: `Source title ${index} ${"t".repeat(60)}`,
          sha256: "a".repeat(64),
          contentPath: `.agentic/research/research_7b/sources/source_${index}.txt`,
          fetchedAt: "2026-08-26T10:00:00.000Z",
        })),
        notes: Array.from({ length: 12 }, (_unused, index) => ({
          id: `item_${index}`,
          text: `OMITTED NOTE ${index} ${"n".repeat(150)}`,
        })),
        reportPath: ".agentic/research/research_7b/report.md",
        statePath: ".agentic/research/research_7b/state.json",
      },
    };
    const compact = compactAgenticToolResult(value, 4000) as Record<string, any>;
    const text = JSON.stringify(compact);
    const records = compact.data.preservedRecoveryFields as Array<{ path: string }>;
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((record) => record.path === "data.id")).toBe(true);
    expect(records.some((record) => record.path.startsWith("data.sources["))).toBe(true);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).not.toContain("OMITTED QUERY TEXT");
    expect(text).not.toContain("OMITTED NOTE");
  });
});

describe("chunkHasAgenticResults", () => {
  test("true when a tool result carries an object-form envelope", () => {
    const msgs: CanonMessage[] = [
      {
        role: "tool",
        text: "",
        // Real CanonMessage.toolResults[].content is always a string, but the
        // detection machinery (parseEnvelope) accepts either form — exercise
        // both here since chunkHasAgenticResults must reuse it as-is.
        toolResults: [{ content: envelope() as unknown as string }],
      },
    ];
    expect(chunkHasAgenticResults(msgs)).toBe(true);
  });

  test("true when a tool result carries a JSON-string envelope", () => {
    const msgs: CanonMessage[] = [
      { role: "tool", text: "", toolResults: [{ content: JSON.stringify(envelope()) }] },
    ];
    expect(chunkHasAgenticResults(msgs)).toBe(true);
  });

  test("false for a plain JSON tool result", () => {
    const msgs: CanonMessage[] = [
      {
        role: "tool",
        text: "",
        toolResults: [{ content: JSON.stringify({ ok: true, data: "x" }) }],
      },
    ];
    expect(chunkHasAgenticResults(msgs)).toBe(false);
  });

  test("false for prose tool results and regular chat messages", () => {
    const msgs: CanonMessage[] = [
      { role: "user", text: "please fix the bug in app.py" },
      { role: "assistant", text: "reading the file first" },
      { role: "tool", text: "", toolResults: [{ content: "def main(): ..." }] },
    ];
    expect(chunkHasAgenticResults(msgs)).toBe(false);
  });

  test("false when there are no tool results at all", () => {
    const msgs: CanonMessage[] = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ];
    expect(chunkHasAgenticResults(msgs)).toBe(false);
  });
});
