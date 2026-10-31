/**
 * Decides whether tools should be handed to a model this turn. Some local
 * models were never trained on a tool-call chat template: passing tools to
 * them either gets silently ignored (the model never calls one) or, worse,
 * crashes a strict template inside act(). Dropping tools for those models is
 * correct, but doing it silently makes the plugin's own get_context_usage
 * tool vanish with no explanation — so this also decides when a one-time
 * warning is warranted. Pure: no SDK/ctl access, trivial to unit test.
 */
export interface ToolGateInput {
  /** Tools available from the LM Studio session (not counting the plugin's own get_context_usage). */
  sessionToolCount: number;
  /** undefined = getModelInfo() failed / capability unknown. */
  trainedForToolUse: boolean | undefined;
}

export interface ToolGateResult {
  passTools: boolean;
  /** One-time user-visible warning; set only when tools were dropped. */
  warning?: string;
}

export function decideTools(input: ToolGateInput): ToolGateResult {
  const { sessionToolCount, trainedForToolUse } = input;
  // true, or undefined (capability unknown): benefit of the doubt — the
  // caller's debug log is where an undefined probe gets diagnosed.
  if (trainedForToolUse !== false) return { passTools: true };
  // No session tools at all: the only casualty is the plugin's own internal
  // get_context_usage tool, and /usage keeps working without it — not worth
  // interrupting the user for.
  if (sessionToolCount === 0) return { passTools: false };
  // The plugin's own get_context_usage tool is always a candidate alongside
  // the session tools, so it's also among what gets dropped here.
  const droppedCount = sessionToolCount + 1;
  return {
    passTools: false,
    warning: `This model is not trained for tool use — ${droppedCount} tool(s) disabled for replies (context tracking still works via /usage).`,
  };
}
