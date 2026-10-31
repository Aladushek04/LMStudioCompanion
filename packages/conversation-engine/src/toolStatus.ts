/**
 * Per-call tool status bridge.
 *
 * LM Studio's native prediction loop shows each tool call as a status
 * widget ("Searching the web…", warnings, succeeded/failed with timing).
 * When this plugin owns the loop, `model.act()` hands every tool a context
 * whose `status()`/`warn()` only write to the plugin log, so another
 * plugin's progress text (e.g. a web-search tool) silently vanishes from
 * the chat. This module rebuilds that widget from a factory the handler
 * backs with `ctl.createToolStatus(...)`. Pure: no SDK imports.
 */
import { isToolErrorResult, toolErrorMessage } from "./toolWrap";

export type ToolStatusState =
  | { type: "callingTool" }
  | { type: "confirmingToolCall" }
  | { type: "toolCallSucceeded"; timeMs: number }
  | { type: "toolCallFailed"; error: string };

/** The subset of the SDK's PredictionProcessToolStatusController we use. */
export interface ToolStatusSink {
  setCustomStatusText(text: string): void;
  addWarning(text: string): void;
  setStatus(state: ToolStatusState): void;
}

export type ToolStatusFactory = (
  callId: number,
  initial: ToolStatusState,
) => ToolStatusSink;

/** The subset of the SDK's ToolCallContext a tool implementation sees. */
export interface ToolCallCtx {
  status: (text: string) => void;
  warn: (text: string) => void;
  signal?: AbortSignal;
  callId?: number;
}

/**
 * Runs `run` with a context whose status/warn calls are mirrored into a
 * per-call tool status created from `factory`, then finalizes that status
 * as succeeded (with elapsed time) or failed. Any status failure — the UI
 * may already have torn the prediction down — is swallowed so the tool
 * call itself is never affected. Without a callId there is nothing to
 * attach a status to, so the tool runs with the original context.
 */
export async function runWithToolStatus<T>(
  ctx: ToolCallCtx,
  factory: ToolStatusFactory,
  run: (ctx: ToolCallCtx,phase:(state:ToolStatusState)=>void) => Promise<T>,
  now: () => number = Date.now,
  initial:ToolStatusState={type:'callingTool'},
): Promise<T> {
  const callId = ctx.callId;
  if (callId === undefined) return run(ctx,()=>{});
  let sink: ToolStatusSink | undefined;
  try {
    sink = factory(callId, initial);
  } catch {
    sink = undefined;
  }
  if (sink === undefined) return run(ctx,()=>{});
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // status detached (prediction teardown) — never fail the tool call
    }
  };
  const bridged: ToolCallCtx = {
    ...ctx,
    status: (text) => {
      safe(() => sink.setCustomStatusText(text));
      ctx.status(text);
    },
    warn: (text) => {
      safe(() => sink.addWarning(text));
      ctx.warn(text);
    },
  };
  const started = now();
  let result: T;
  try {
    result = await run(bridged,state=>safe(()=>sink.setStatus(state)));
  } catch (error) {
    safe(() =>
      sink.setStatus({
        type: "toolCallFailed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
  if (isToolErrorResult(result)) {
    safe(() =>
      sink.setStatus({ type: "toolCallFailed", error: toolErrorMessage(result) }),
    );
  } else {
    safe(() =>
      sink.setStatus({
        type: "toolCallSucceeded",
        timeMs: Math.max(0, now() - started),
      }),
    );
  }
  return result;
}
