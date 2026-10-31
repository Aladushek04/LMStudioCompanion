/**
 * Pure planning of the model-facing "view" message list, independent of the
 * SDK's Chat type so it stays trivially testable. Two strategies:
 *
 * - "system": one leading system message (today's behavior everywhere).
 * - "foldSystem": no system role anywhere, for chat templates (stock Gemma,
 *   some Mistral variants) that throw on one. The system text is folded into
 *   a user turn instead, and user-first alternation is preserved.
 *
 * planViewMessages never decides raw-vs-text fidelity for tail messages —
 * that's a handler-only concern (whether the original ChatMessage survived
 * transformForView unchanged). It signals "this output message corresponds
 * to tail[fromTailIndex]; prefer the raw ChatMessage there, falling back to
 * this text" via ViewMsg.fromTailIndex, and always supplies the fallback
 * text so the caller never needs to.
 */
import type { SummaryPrompt } from "./summarizer";
import { CanonMessage } from "./view";

export type ViewStrategy = "system" | "foldSystem";

export interface ViewMsg {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  /** Index into the tail array whose raw ChatMessage should be appended verbatim; unset = append as text. */
  fromTailIndex?: number;
}

// Same predicate as src/view.ts's exported hasUserMessage, duplicated locally
// (rather than imported) so this pure planning module's only dependency on
// view.ts stays the CanonMessage type — see src/view.ts#hasUserMessage for
// the original and its rationale (chat templates that reject a userless
// conversation).
function hasUserMessage(tail: CanonMessage[]): boolean {
  return tail.some((m) => m.role === "user");
}

/**
 * Emit tail messages verbatim (fromTailIndex, offset by `offset` into the
 * original tail array) except mid-history system messages, which are always
 * downgraded to annotated user text regardless of strategy — shared by both
 * strategies since neither ever wants a mid-history system role.
 */
function planTail(tail: CanonMessage[], offset = 0): ViewMsg[] {
  return tail.map((m, i) =>
    m.role === "system"
      ? { role: "user", text: `[system note] ${m.text}` }
      : { role: m.role, text: m.text, fromTailIndex: offset + i },
  );
}

export function planViewMessages(
  systemText: string | undefined,
  tail: CanonMessage[],
  strategy: ViewStrategy,
  syntheticUserText: string,
): ViewMsg[] {
  if (strategy === "system") {
    const out: ViewMsg[] = [];
    if (systemText !== undefined) out.push({ role: "system", text: systemText });
    if (!hasUserMessage(tail)) out.push({ role: "user", text: syntheticUserText });
    out.push(...planTail(tail));
    return out;
  }

  // foldSystem: no system role in any output message.
  if (systemText === undefined) {
    // Identical to "system" minus the (absent) system message.
    const out: ViewMsg[] = [];
    if (!hasUserMessage(tail)) out.push({ role: "user", text: syntheticUserText });
    out.push(...planTail(tail));
    return out;
  }

  if (tail.length > 0 && tail[0].role === "user") {
    // Merge into the first user turn: loses raw fidelity (attached files) on
    // that single message, an accepted tradeoff (attachment memory covers
    // file content). Already user-first, so no synthetic user is needed.
    const merged: ViewMsg = { role: "user", text: `${systemText}\n\n${tail[0].text}` };
    return [merged, ...planTail(tail.slice(1), 1)];
  }

  // Otherwise (tail empty, or starts with assistant/tool/system): inject a
  // new leading user message carrying the folded system text — this also
  // keeps user-first alternation for Gemma-style templates, and already
  // counts as the one required user message, so the tail below never gets a
  // second synthetic user injected.
  const leading: ViewMsg = { role: "user", text: `${systemText}\n\n${syntheticUserText}` };
  return [leading, ...planTail(tail)];
}

export interface PromptMessage {
  role: "system" | "user";
  content: string;
}

/**
 * Build the message list for a plugin-internal prediction (chunk
 * summarization, consolidation merge, attachment memory) from a
 * {system, user} prompt pair, honoring the same no-system-role fold as the
 * compressed view: "system" emits both messages as-is; "foldSystem" merges
 * them into a single user message so the request never carries a system
 * role — the same chat templates that reject a system role in the main view
 * reject it here too.
 */
export function promptChatMessages(
  prompt: SummaryPrompt,
  strategy: ViewStrategy,
): PromptMessage[] {
  if (strategy === "foldSystem") {
    return [{ role: "user", content: `${prompt.system}\n\n${prompt.user}` }];
  }
  return [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
}
