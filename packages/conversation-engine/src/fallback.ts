/**
 * Decide what to show when a prediction finishes with an empty visible
 * reply — LM Studio renders that as "This message contains no content",
 * which reads as a failure. Reasoning-only replies get their text promoted
 * (it is usually the actual answer, misrouted); truly empty non-tool turns
 * get an explicit notice.
 */
import { LM_STUDIO_INTERNAL_MARKER, stripReasoningMarkers } from "./reasoning";
import { SENTINEL } from "./view";

export interface FallbackInput {
  /** Characters that reached the visible (non-thinking) reply block. */
  visibleChars: number;
  /** Full text of reasoning fragments, if any. */
  reasoningText: string;
  /** Tool calls made this turn (tool-only turns are legitimate). */
  toolRequestCount: number;
}

export type Fallback =
  | { kind: "promote"; text: string }
  | { kind: "notice"; text: string }
  | null;

/** Remove LM Studio internal markers that must never reach the chat. */
function sanitizeInternalMarkers(text: string): string {
  return text.replace(LM_STUDIO_INTERNAL_MARKER, "").trim();
}

// Last-resort raw fallback: when a reasoning span had nothing outside it
// (stripReasoningMarkers legitimately reduces it to ""), promote the
// content anyway with just the marker literals peeled off, across every
// family stripReasoningMarkers recognizes.
const MARKER_LITERALS_RE =
  /<\/?think>|\[\/?THINK\]|◁\/?think▷|<\/?reasoning>|<\|channel\|>analysis<\|message\|>|<\|start\|>assistant<\|channel\|>final<\|message\|>|<\|channel\|>final<\|message\|>|<\|end\|>/g;

function stripMarkerLiterals(text: string): string {
  return text.replace(MARKER_LITERALS_RE, "").trim();
}

export function decideFallback(input: FallbackInput): Fallback {
  if (input.visibleChars > 0) return null;
  const reasoning = input.reasoningText.trim();
  if (reasoning !== "") {
    const stripped = sanitizeInternalMarkers(stripReasoningMarkers(reasoning));
    const raw = sanitizeInternalMarkers(stripMarkerLiterals(reasoning));
    if (stripped === "" && raw === "") {
      // nothing but markers: fall through to the notice path
    } else {
      return { kind: "promote", text: stripped !== "" ? stripped : raw };
    }
  }
  if (input.toolRequestCount > 0) return null;
  return {
    kind: "notice",
    text: `${SENTINEL} The model produced no output this turn — try sending your message again or rephrasing.`,
  };
}
