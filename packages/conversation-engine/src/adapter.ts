/**
 * Thin adapter from SDK ChatMessage objects to the plain CanonMessage shape
 * the pure logic operates on. Kept minimal: everything interesting is tested
 * against CanonMessage directly.
 */
import { ChatMessage, LMStudioClient } from "@lmstudio/sdk";
import { stripSyntheticReasoning } from "./reasoning";
import { CanonMessage } from "./view";

export function toCanon(m: ChatMessage, client: LMStudioClient): CanonMessage {
  let files: string[] | undefined;
  try {
    if (m.hasFiles()) files = m.getFiles(client).map((f) => f.name);
  } catch {
    files = ["<unreadable attachment>"];
  }
  return {
    role: m.getRole(),
    // LM Studio hands handler-produced replies back with their reasoning and
    // a synthetic end marker inlined; keep only the visible content.
    text: stripSyntheticReasoning(m.getText()),
    toolCalls: m.getToolCallRequests().map((r) => ({
      name: r.name,
      args: JSON.stringify(r.arguments ?? {}),
    })),
    toolResults: m.getToolCallResults().map((r) => ({ content: r.content })),
    files,
  };
}
