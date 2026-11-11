/**
 * Tool-result capping: wrap remote tools so oversized results are truncated
 * before they enter the conversation history. Side effects still happen —
 * only what the model sees shrinks.
 */
import { compactAgenticToolResult } from "./agenticProtocol";
import { charBudget, estimateTokens } from "./estimate";

export const TRUNCATION_MARKER = "[context-compressor: truncated,";

/**
 * Approximate chars-per-token for plain ASCII/Latin text — the "other"
 * class in estimateTokens. Kept for reference/back-compat; the actual
 * truncation budget below is content-aware (see estimate.ts) rather than
 * using this flat ratio, which badly under-truncates CJK and base64 blobs.
 */
export const CHARS_PER_TOKEN = 4;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function truncateToolResult(result: unknown, maxTokens: number): unknown {
  if (maxTokens <= 0) return result;
  let candidate = result;
  let asString = typeof candidate === "string" ? candidate : safeJson(candidate);
  if (estimateTokens(asString) <= maxTokens) return result;
  const protocolCompact = compactAgenticToolResult(
    candidate,
    charBudget(asString, maxTokens),
  );
  const compactString =
    typeof protocolCompact === "string"
      ? protocolCompact
      : safeJson(protocolCompact);
  if (compactString.length < asString.length) {
    candidate = protocolCompact;
    asString = compactString;
    if (estimateTokens(asString) <= maxTokens) return candidate;
  }
  // Keep both ends: command output puts stack traces, exit codes, and test
  // summaries at the END — tail content is usually the most valuable.
  const charCap = charBudget(asString, maxTokens);
  const headLen = Math.floor(charCap * 0.3);
  const tailLen = charCap - headLen;
  const omitted = asString.length - headLen - tailLen;
  return (
    asString.slice(0, headLen) +
    `\n${TRUNCATION_MARKER} ${omitted} characters omitted]\n` +
    asString.slice(asString.length - tailLen)
  );
}

/**
 * The tool-result message fed back to the model when it emits an invalid
 * tool request (e.g. malformed JSON arguments), so it can retry instead of
 * the whole prediction failing.
 */
export function invalidToolRequestResult(errorMessage: string): string {
  const firstLine = errorMessage.split(/\r?\n/)[0].slice(0, 260);
  return `Tool call failed: ${firstLine} — fix the arguments (they must be valid JSON) and try again.`;
}

export interface CappableTool {
  name: string;
  description: string;
  implementation: (
    params: Record<string, unknown>,
    ctx: unknown,
  ) => unknown | Promise<unknown>;
}

/**
 * The tool result fed back to the model when a tool's execution throws
 * (failed process, network error, ...). Feeding the error back lets the
 * model react to it — the native LM Studio behavior — instead of the
 * whole reply dying.
 */
export const TOOL_ERROR_PREFIX = "Tool execution failed: ";

export function toolErrorResult(errorMessage: string): string {
  return `${TOOL_ERROR_PREFIX}${errorMessage.slice(0, 1000)}`;
}

/** True when `result` is a toolErrorResult() produced by wrapToolsWithCap. */
export function isToolErrorResult(result: unknown): result is string {
  return typeof result === "string" && result.startsWith(TOOL_ERROR_PREFIX);
}

/** The original error message inside a toolErrorResult() string. */
export function toolErrorMessage(result: string): string {
  return result.startsWith(TOOL_ERROR_PREFIX)
    ? result.slice(TOOL_ERROR_PREFIX.length)
    : result;
}

/**
 * Returns tools whose implementations truncate results beyond
 * maxResultTokens (approximate; <= 0 disables capping) and convert
 * execution errors into error results the model can react to. Aborted
 * calls still rethrow so cancellation works.
 */
export function wrapToolsWithCap<T extends CappableTool>(
  tools: T[],
  maxResultTokens: number,
  maxAggregateTokens = 0,
): T[] {
  // Second line of defense: per-result caps still let many calls flood the
  // context, so the total across all calls this turn is budgeted too.
  let aggregateTokens = 0;
  return tools.map((tool) => ({
    ...tool,
    implementation: async (params: Record<string, unknown>, ctx: unknown) => {
      try {
        let out = truncateToolResult(
          await tool.implementation(params, ctx),
          maxResultTokens,
        );
        const outStr = typeof out === "string" ? out : safeJson(out);
        if (
          maxAggregateTokens > 0 &&
          aggregateTokens + estimateTokens(outStr) > maxAggregateTokens
        ) {
          out =
            outStr.slice(0, 300) +
            `\n${TRUNCATION_MARKER} aggregate tool-output budget reached — result heavily truncated]`;
        }
        aggregateTokens += estimateTokens(
          typeof out === "string" ? out : safeJson(out),
        );
        return out;
      } catch (error) {
        const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;
        if (signal?.aborted) throw error;
        return toolErrorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  }));
}
