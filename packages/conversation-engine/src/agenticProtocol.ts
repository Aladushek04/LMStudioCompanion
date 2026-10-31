/**
 * Native compaction for Agentic Workspace's durable result envelope.
 *
 * Generic head/tail truncation can discard transaction IDs, run IDs, task
 * state, source ledgers, artifact paths, and — since the workspace grew a
 * permission gate — the staged approval a blocked mutation must be resumed
 * with (`approval_*` / `plan_*` ids, the pending status, and the exact
 * resume call). This module understands the protocol and reduces bulky
 * payloads while preserving those recovery keys.
 */

import { CanonMessage } from "./view";

export const AGENTIC_WORKSPACE_PROTOCOL = "agentic-workspace/v1";

interface AgenticEnvelope {
  protocol: typeof AGENTIC_WORKSPACE_PROTOCOL;
  ok: boolean;
  operation: string;
  summary: string;
  retention?: {
    importance?: string;
    facts?: unknown[];
    omit_when_summarizing?: unknown[];
  };
  artifacts?: unknown[];
  data?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseEnvelope(value: unknown): {
  envelope: AgenticEnvelope;
  inputWasString: boolean;
} | undefined {
  let parsed = value;
  const inputWasString = typeof value === "string";
  if (inputWasString) {
    const text = value.trim();
    if (!text.startsWith("{") || !text.includes(AGENTIC_WORKSPACE_PROTOCOL)) {
      return undefined;
    }
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (
    !isRecord(parsed) ||
    parsed.protocol !== AGENTIC_WORKSPACE_PROTOCOL ||
    typeof parsed.operation !== "string" ||
    typeof parsed.summary !== "string"
  ) {
    return undefined;
  }
  return { envelope: parsed as AgenticEnvelope, inputWasString };
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function deleteJsonPath(root: unknown, rawPath: string): void {
  const parts = rawPath
    .replace(/^\$\.?/, "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || !isRecord(root)) return;
  let current: Record<string, unknown> = root;
  for (let index = 0; index < parts.length - 1; index++) {
    const next = current[parts[index]];
    if (!isRecord(next)) return;
    current = next;
  }
  delete current[parts[parts.length - 1]];
}

const IMPORTANT_KEYS = new Set([
  "id",
  "status",
  "state",
  "mode",
  "ok",
  "operation",
  "summary",
  "title",
  "objective",
  "error",
  "code",
  "message",
  "confidence",
  "name",
  "type",
  "path",
  "root",
  "memory",
  "url",
  "sha256",
  "bytes",
  "kind",
  "description",
  "text",
  "note",
  "priority",
  "details",
  "dependsOn",
  "blockers",
  "decisions",
  "next",
  "query",
  "provider",
  "excerpt",
  "destructive",
  "requiresReview",
  "added",
  "removed",
  "beforeSha256",
  "afterSha256",
  "executable",
  // Windows npm shims are rewritten to `node <script>`: without these the
  // recorded call cannot be matched to what actually ran.
  "resolvedExecutable",
  "resolvedScript",
  "args",
  "cwd",
  "exitCode",
  "signal",
  "timedOut",
  "durationMs",
  "stdoutTruncated",
  "stderrTruncated",
  // How much was hidden. `linksOmitted`, `stdoutBytes`, `omittedChars` and the
  // rest of that family are matched by the suffix rule in isImportantKey;
  // these two carry no suffix of their own. A result that says "truncated"
  // without saying how much is a result the model cannot reason about.
  "truncated",
  "total",
  "contentType",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "completedAt",
  "archivedAt",
  "fetchedAt",
  "modifiedAt",
  "counts",
  "count",
  "files",
  // A mkdir-only transaction has no files at all: without `directories` it
  // reads as a transaction that changed nothing, and `directoryCount` alone
  // says how many without saying which.
  "directories",
  "filesTruncated",
  "directoriesTruncated",
  "filesChanged",
  "filesRead",
  "transactions",
  "command",
  "commands",
  "sources",
  "items",
  "nextActionable",
  "plan",
  // An approved plan's content: which way each file moves (create / modify /
  // delete), and what the plan said was risky or unresolved.
  "change",
  "risks",
  "questions",
  // research.deep returns { project, agentRun }: two wrappers whose own names
  // carry no id prefix, but whose contents are the whole recovery state.
  "project",
  "agentRun",
  // A sub-agent run carries its own gate state instead of a permission mode
  // (agents/orchestrator.ts): `commitEdits` decides whether its edits land at
  // all. The pass/tool-call budget says how much of the run is left.
  "role",
  "commitEdits",
  "allowCommands",
  "allowWeb",
  "pass",
  "maxPasses",
  "toolCalls",
  "maxToolCalls",
  // Permission gate (agentic-workspace policy/gateRuntime.ts stagedResult):
  // a blocked mutation returns status "pending_approval" plus the approval
  // record and the exact call to re-issue after the user types /accept.
  // `approval`, `approvals`, `plans`, `planPath`, `planId` are matched by the
  // prefix rule in isImportantKey; these are the rest of that payload.
  "action",
  "arguments",
  "resume",
  "tool",
  "instruction",
  "revision",
  "supersedes",
  "permissionMode",
  "permissionLevel",
  "activePlan",
  "pendingPlan",
  "pendingApprovals",
  // workspace_inspect capabilities: which workspace, which feature flags, and
  // where the plugin's own state lives. The model plans around these — asking
  // for a command run that `processExecution: false` will refuse is a wasted
  // turn, and `notes.memoryPath` is how it finds MEMORY.md again.
  "workspace",
  "notes",
  "destructiveCommits",
  "processExecution",
  "durableAgents",
  "webResearch",
  "webSearchProvider",
  "agentWebAccess",
  "gitAndGitHub",
  "browserAutomation",
  "tools",
  "storage",
  "editVisibility",
  "final",
  "evidence",
  "remaining",
  "artifacts",
  "resultProtocol",
]);

/**
 * A staged approval's `resume` is the exact call the model must re-issue after
 * /accept, so it is kept byte-for-byte: no key filter (dropping `action` or a
 * tool-specific flag makes the record useless) and no per-string compaction (a
 * `…[N chars omitted]…` marker spliced into a stdin or PR body is silent
 * corruption of a call the model is told to repeat verbatim). Only a resume
 * larger than this budget is dropped, and then wholesale — a truncated call is
 * not a call, and the model recovers the real one from the approval id.
 */
const RESUME_ARGUMENTS_MAX_CHARS = 12_000;

const RESUME_OMITTED_NOTE =
  "Resume call omitted: its arguments exceeded the verbatim budget, and a " +
  "truncated call is not a call. Recover it with workspace_inspect " +
  '{ action: "changes" } and this approval id before re-issuing.';

function compactResume(value: Record<string, unknown>): Record<string, unknown> {
  const args = value.arguments;
  if (args !== undefined && safeStringify(args).length > RESUME_ARGUMENTS_MAX_CHARS) {
    return { omitted: "arguments_too_large", note: RESUME_OMITTED_NOTE };
  }
  return cloneJson(value);
}

function isImportantKey(key: string): boolean {
  // `recentTransactions`, `recentRuns`, `recentTaskBoards`,
  // `recentResearchProjects`: workspace_inspect overview names its durable
  // collections that way, and the anchored family rule below matches none of
  // them — an overview would arrive with every id stripped out of it.
  const family = key.replace(/^recent(?=[A-Z])/, "");
  return (
    IMPORTANT_KEYS.has(key) ||
    /(?:^|_)(?:id|ids|path|paths|url|urls|status|count|counts|sha256)$/i.test(key) ||
    // ...and the counters that say how much was hidden: `linksOmitted`,
    // `stdoutBytes`, `stdoutCapturedBytes`, `diffOmittedChars`,
    // `omittedEntries`, `addedLines`/`removedLines`.
    /(?:Id|Ids|Path|Paths|Url|Urls|Status|Count|Counts|Sha256|Omitted|Bytes|Chars|Entries|Lines)$/.test(
      key,
    ) ||
    // Durable-state key families, by the id prefix they carry: tx_/run_/job_/
    // todo_/item_/research_/source_ and the gate's plan_/approval_.
    /^(?:transaction|run|job|task|todo|board|research|source|query|checkpoint|plan|approval)/i.test(
      family,
    )
  );
}

function compactString(value: string, max = 1800): string {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${value.slice(0, head)}…[${value.length - max} chars omitted]…${value.slice(-tail)}`;
}

function compactValue(value: unknown, depth = 0, key = ""): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const limit = /(?:summary|objective|message|evidence|remaining)/i.test(key)
      ? 3000
      : 1400;
    return compactString(value, limit);
  }
  // Verbatim islands, checked before the depth cut so a deeply nested staged
  // approval still resumes: the resume call and any argument object.
  if (isRecord(value)) {
    if (key === "resume") return compactResume(value);
    if (key === "arguments") {
      return safeStringify(value).length <= RESUME_ARGUMENTS_MAX_CHARS
        ? cloneJson(value)
        : undefined;
    }
  }
  if (depth >= 5) return undefined;
  if (Array.isArray(value)) {
    const maxItems = /(?:source|file|transaction|item|task|evidence|remaining|artifact)/i.test(key)
      ? 30
      : 20;
    const items = value
      .slice(0, maxItems)
      .map((item) => compactValue(item, depth + 1, key))
      .filter((item) => item !== undefined);
    if (value.length > maxItems) {
      items.push({ omittedItems: value.length - maxItems });
    }
    return items;
  }
  if (!isRecord(value)) return compactString(String(value), 1000);

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [childKey, childValue] of entries) {
    if (!isImportantKey(childKey)) continue;
    const compacted = compactValue(childValue, depth + 1, childKey);
    if (compacted !== undefined) output[childKey] = compacted;
  }
  if (Object.keys(output).length === 0) {
    if (safeStringify(value).length <= 3000) {
      // Some small objects (for example counts or a tiny final result) have
      // keys that are not individually recognizable. Preserve them if
      // inexpensive.
      for (const [childKey, childValue] of entries.slice(0, 30)) {
        const compacted = compactValue(childValue, depth + 1, childKey);
        if (compacted !== undefined) output[childKey] = compacted;
      }
    } else {
      // A larger wrapper whose own keys mean nothing (research.deep's
      // { project, agentRun }) still holds its ids and state paths one level
      // down. Recurse into the containers rather than dropping the subtree
      // whole; unrecognized leaves stay out, so no bulk comes back with them.
      for (const [childKey, childValue] of entries.slice(0, 30)) {
        if (!isRecord(childValue) && !Array.isArray(childValue)) continue;
        const compacted = compactValue(childValue, depth + 1, childKey);
        if (compacted !== undefined) output[childKey] = compacted;
      }
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function compactArtifacts(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 40).map((artifact) => {
    if (!isRecord(artifact)) return compactValue(artifact, 1, "artifact");
    const out: Record<string, unknown> = {};
    for (const key of ["kind", "path", "sha256", "bytes", "description"]) {
      if (artifact[key] !== undefined) out[key] = compactValue(artifact[key], 1, key);
    }
    return out;
  });
}

/**
 * The last-resort recovery index: a flat list of the identifying leaves under
 * `data`, bounded both by count and by `maxChars` — the overflow path exists
 * because the envelope was already too large, so its replacement has to fit
 * the same cap. Runs on the omit-stripped clone, never on the original data.
 */
function criticalRecords(
  value: unknown,
  maxChars: number,
): Array<{ path: string; value: unknown }> {
  const records: Array<{ path: string; value: unknown }> = [];
  let used = 0;
  const visit = (current: unknown, path: string, depth: number): void => {
    if (records.length >= 120 || used >= maxChars || depth > 6) return;
    if (Array.isArray(current)) {
      current.slice(0, 40).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, child] of Object.entries(current)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (
        isImportantKey(key) &&
        (typeof child === "string" || typeof child === "number" || typeof child === "boolean")
      ) {
        const record = { path: nextPath, value: compactValue(child, depth + 1, key) };
        // Counted before the record joins the list, separator included: the
        // budget is a bound, not a target to overshoot by one entry.
        const cost = safeStringify(record).length + 1;
        if (used + cost > maxChars) return;
        used += cost;
        records.push(record);
      } else {
        visit(child, nextPath, depth + 1);
      }
      if (records.length >= 120 || used >= maxChars) return;
    }
  };
  visit(value, "data", 0);
  return records;
}

/**
 * Clone the envelope and delete every payload the plugin declared omittable.
 * Both later stages — the compact envelope and the overflow record list — work
 * from this clone, so a declared omission can never be walked back in.
 */
function stripOmittedPayloads(envelope: AgenticEnvelope): {
  cloned: AgenticEnvelope;
  omit: string[];
} {
  const cloned = cloneJson(envelope);
  const declared = cloned.retention?.omit_when_summarizing;
  const omit = Array.isArray(declared)
    ? declared.filter((path): path is string => typeof path === "string")
    : [];
  for (const path of omit) deleteJsonPath(cloned, path);
  return { cloned, omit };
}

function makeCompactEnvelope(
  cloned: AgenticEnvelope,
  omit: string[],
): Record<string, unknown> {
  const facts = Array.isArray(cloned.retention?.facts)
    ? cloned.retention?.facts
        .filter((fact): fact is string => typeof fact === "string")
        .slice(0, 60)
        .map((fact) => compactString(fact, 2200))
    : undefined;
  const output: Record<string, unknown> = {
    protocol: AGENTIC_WORKSPACE_PROTOCOL,
    ok: Boolean(cloned.ok),
    operation: cloned.operation,
    summary: compactString(cloned.summary, 4000),
    retention: {
      importance: cloned.retention?.importance ?? "normal",
      ...(facts?.length ? { facts } : {}),
      ...(omit.length ? { omittedPayloads: omit.slice(0, 40) } : {}),
    },
  };
  const artifacts = compactArtifacts(cloned.artifacts);
  if (artifacts?.length) output.artifacts = artifacts;
  const error = compactValue(cloned.error, 0, "error");
  if (error !== undefined) output.error = error;
  const data = compactValue(cloned.data, 0, "data");
  if (data !== undefined) output.data = data;
  return output;
}

const OVERFLOW_NOTE =
  "Bulky protocol data was omitted; reopen the durable artifact/state path with Agentic Workspace tools.";

/** Return a protocol-aware compact value, or the original value if unrelated. */
export function compactAgenticToolResult(
  result: unknown,
  maxChars = 12_000,
): unknown {
  const parsed = parseEnvelope(result);
  if (!parsed) return result;
  const { cloned, omit } = stripOmittedPayloads(parsed.envelope);
  const compact = makeCompactEnvelope(cloned, omit);
  if (maxChars > 0 && safeStringify(compact).length > maxChars) {
    const previous = isRecord(compact.data) ? compact.data : undefined;
    // A blocked mutation is nothing but its approval: keep the pending status,
    // the mode and the resume call verbatim rather than hoping they win a
    // place in the bounded scan below.
    const approval =
      previous?.status === "pending_approval"
        ? {
            status: previous.status,
            ...(previous.mode === undefined ? {} : { mode: previous.mode }),
            ...(previous.approval === undefined
              ? {}
              : { approval: previous.approval }),
          }
        : {};
    if (isRecord(compact.retention) && Array.isArray(compact.retention.facts)) {
      compact.retention.facts = compact.retention.facts.slice(0, 30);
    }
    if (Array.isArray(compact.artifacts)) compact.artifacts = compact.artifacts.slice(0, 30);
    // Measure the rest of the envelope first, then let the record list have
    // whatever the cap leaves — an unbounded list once turned a 500-char
    // budget into 5 KB of output.
    compact.data = { ...approval, preservedRecoveryFields: [], note: OVERFLOW_NOTE };
    const budget = Math.max(0, maxChars - safeStringify(compact).length);
    compact.data = {
      ...approval,
      preservedRecoveryFields: criticalRecords(cloned.data, budget),
      note: OVERFLOW_NOTE,
    };
  }
  return parsed.inputWasString ? safeStringify(compact) : compact;
}

/** Render a tool result for the summarizer without feeding it bulky payloads. */
export function renderAgenticToolResultForSummary(
  result: unknown,
  maxChars = 12_000,
): string {
  const compact = compactAgenticToolResult(result, maxChars);
  const text = typeof compact === "string" ? compact : safeStringify(compact);
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const head = Math.max(0, Math.floor(maxChars * 0.75));
  const tail = Math.max(0, maxChars - head);
  return `${text.slice(0, head)}\n[agentic protocol payload omitted]\n${text.slice(-tail)}`;
}

export function isAgenticWorkspaceResult(value: unknown): boolean {
  return parseEnvelope(value) !== undefined;
}

/**
 * True when any message in the chunk carries a tool result whose content
 * parses as an agentic-workspace/v1 envelope (object or JSON-string form —
 * reuses parseEnvelope's own guards, so it's cheap on plain-JSON or prose
 * tool results). Used to decide whether the summarizer prompt needs its
 * agentic-only sections (Durable workflow state / Source ledger / the
 * transaction-ID sentence): a pure function of chunk content, so identical
 * chains always regenerate the same prompt and byte-identical summaries.
 */
export function chunkHasAgenticResults(msgs: CanonMessage[]): boolean {
  for (const m of msgs) {
    for (const r of m.toolResults ?? []) {
      if (isAgenticWorkspaceResult(r.content)) return true;
    }
  }
  return false;
}
