/**
 * Reasoning ("thinking") text must never leak into permanently-cached
 * summaries or influence non-thinking-model behavior. Pure text/string
 * functions only — no SDK imports — so this stays trivially testable and
 * safe to run against both the engine-parsed fields and raw model text.
 */

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A reasoning marker family: an opening tag and its matching closer. */
interface MarkerPair {
  open: string;
  close: string;
}

// <think>/[THINK]/Kimi's ◁think▷/<reasoning> all share the same shape: a
// literal open tag, arbitrary content, a literal close tag. Harmony's
// channel markers are handled separately below (they nest differently).
const MARKER_PAIRS: MarkerPair[] = [
  { open: "<think>", close: "</think>" },
  { open: "[THINK]", close: "[/THINK]" },
  { open: "◁think▷", close: "◁/think▷" }, // Kimi ◁think▷...◁/think▷
  { open: "<reasoning>", close: "</reasoning>" },
];

function stripMarkerPair(text: string, pair: MarkerPair): string {
  const open = escapeRegExp(pair.open);
  const close = escapeRegExp(pair.close);
  // Terminated spans anywhere in the text, non-greedy so adjacent spans
  // don't merge into one match.
  let out = text.replace(new RegExp(`${open}[\\s\\S]*?${close}`, "g"), "");
  // A remaining open marker has no matching close (the model was cut off
  // mid-reasoning): strip it through end of text rather than let it pass.
  out = out.replace(new RegExp(`${open}[\\s\\S]*$`), "");
  return out;
}

const HARMONY_START_ASSISTANT = "<\\|start\\|>assistant";
const HARMONY_CHANNEL = "<\\|channel\\|>";
const HARMONY_MESSAGE = "<\\|message\\|>";
const HARMONY_END = "<\\|end\\|>";
// Canonical Harmony output precedes each channel header with a
// <|start|>assistant control token; tolerate it being present or absent on
// both the analysis opener and the final-channel header.
const HARMONY_ANALYSIS_OPEN = `(?:${HARMONY_START_ASSISTANT})?${HARMONY_CHANNEL}analysis${HARMONY_MESSAGE}`;
const HARMONY_FINAL_HEADER = `(?:${HARMONY_START_ASSISTANT})?${HARMONY_CHANNEL}final${HARMONY_MESSAGE}`;

// gpt-oss Harmony: the analysis channel is reasoning.
// 1) Terminated by <|end|>: strip through it.
const HARMONY_ANALYSIS_ENDED = new RegExp(
  `${HARMONY_ANALYSIS_OPEN}[\\s\\S]*?${HARMONY_END}`,
  "g",
);
// 2) No <|end|> seen, but a final-channel header follows: stop right before
// it (a lookahead, so the header itself is left for the pass below — this
// must stay independent of whether <|end|> also happened to precede it).
const HARMONY_ANALYSIS_TO_FINAL = new RegExp(
  `${HARMONY_ANALYSIS_OPEN}[\\s\\S]*?(?=${HARMONY_FINAL_HEADER})`,
  "g",
);
// 3) Neither terminator seen (cut off mid-generation): strip to end of text.
const HARMONY_ANALYSIS_UNTERMINATED = new RegExp(`${HARMONY_ANALYSIS_OPEN}[\\s\\S]*$`);
// The final-channel header is always a control token, never the answer.
// Unconditional pass, independent of the analysis-stripping above: it
// catches the header whether it followed a stripped <|end|> (the analysis
// pass above only consumes through <|end|>, not past it), a bare prefix
// with no analysis section at all, or a doubly <|start|>assistant-wrapped
// opener.
const HARMONY_FINAL_HEADER_RE = new RegExp(HARMONY_FINAL_HEADER, "g");

function stripHarmony(text: string): string {
  let out = text.replace(HARMONY_ANALYSIS_ENDED, "");
  out = out.replace(HARMONY_ANALYSIS_TO_FINAL, "");
  out = out.replace(HARMONY_ANALYSIS_UNTERMINATED, "");
  out = out.replace(HARMONY_FINAL_HEADER_RE, "");
  return out;
}

/**
 * Remove reasoning spans from every family the plugin has seen in the wild:
 * <think>, [THINK] (Magistral), ◁think▷ (Kimi), <reasoning> (Granite/EXAONE),
 * and gpt-oss Harmony channels. An unterminated opening marker (the model
 * was truncated mid-reasoning) strips through end of text rather than
 * passing the partial reasoning through untouched.
 */
/**
 * LM Studio (0.4.15) persists a reply produced by a prediction-loop handler as
 * "<reasoning>__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_<hex>__<content>",
 * one such pair per tool round in a single text: the app parses the think
 * tags we stream for display, then flattens each round back to plain text
 * with a synthetic end-of-reasoning marker, and ChatMessage.getText() hands
 * that whole string back as history. Left in place, the reasoning is re-sent
 * as content and the model learns to echo the marker itself (observed on
 * qwen3.8-27b). There is no start marker, so the content of a round cannot
 * be told apart from the next round's reasoning: only what follows the last
 * marker is kept, which is the reply's final visible text.
 */
const SYNTHETIC_REASONING_END =
  /__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_[0-9a-f]+__/g;

/**
 * Any LM Studio internal marker literal, with or without its `__` fences.
 * Matches only the marker itself, never the word that follows it.
 */
export const LM_STUDIO_INTERNAL_MARKER =
  /_{0,2}LM_STUDIO_INTERNAL_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_{0,2}/g;

/** Text with the synthetic reasoning span(s) and any internal markers removed. */
export function stripSyntheticReasoning(text: string): string {
  if (!text.includes("LM_STUDIO_INTERNAL_")) return text;
  let out = text;
  let lastEnd = -1;
  for (const m of out.matchAll(SYNTHETIC_REASONING_END)) {
    lastEnd = (m.index ?? 0) + m[0].length;
  }
  if (lastEnd >= 0) out = out.slice(lastEnd);
  return out.replace(LM_STUDIO_INTERNAL_MARKER, "").trim();
}

export function stripReasoningMarkers(text: string): string {
  let out = stripSyntheticReasoning(text);
  for (const pair of MARKER_PAIRS) out = stripMarkerPair(out, pair);
  out = stripHarmony(out);
  return out.trim();
}

/**
 * The text a caller should actually use from a prediction result: the
 * engine's own non-reasoning parse when the model family is one it
 * recognizes, always passed through the regex strippers too (the engine
 * only parses families it knows about for that model). Empty means
 * "nothing usable" — callers must treat that as failure, never cache it.
 */
export function extractPayload(result: {
  content: string;
  reasoningContent?: string;
  nonReasoningContent?: string;
}): string {
  return stripReasoningMarkers(result.nonReasoningContent ?? result.content).trim();
}

/**
 * A prediction that produced no usable payload because the model spent its
 * whole budget reasoning and was cut off before answering. Measured on
 * qwen3.8-27b consolidation merges: ~6,600 tokens of reasoning at every
 * budget and prompt variant, never one visible character — retrying is a
 * pure waste, and the caller should stop asking this model for that task.
 */
export function burnedOutInReasoning(
  payload: string,
  stopReason: string | undefined,
): boolean {
  return payload === "" && isTruncatedStop(stopReason);
}

/** Stop reasons meaning the reply was cut off, not concluded naturally. */
export function isTruncatedStop(stopReason: string | undefined): boolean {
  return (
    stopReason === "maxPredictedTokensReached" ||
    stopReason === "contextLengthReached"
  );
}

/**
 * The soft-switch that suppresses reasoning for models known to honor one,
 * keyed off model identifier. Firing this on a model that doesn't honor it
 * is harmless (the model ignores unrecognized text); firing it on a
 * non-thinking model of the same family (e.g. qwen2.5) wastes nothing but
 * is avoided anyway by matching only the thinking-capable identifiers.
 *
 * The qwen3 alternative excludes identifiers where "qwen3" is immediately
 * followed by a dot or digit (e.g. "qwen/qwen3.8-27b", "qwen3.6-27b-nemesis",
 * "qwen35-arch-model") — verified live: /no_think is honored by qwen3 and
 * QwQ/SmolLM3, but the qwen3.5+ line ignores the directive entirely, reasons
 * regardless, and even echoes it back as if it were task text. Sending a
 * dead directive is not harmless there — it can starve the visible answer
 * of its token budget (see isTruncatedStop / the summarizer headroom retry
 * in handler.ts).
 */
export function noThinkDirective(identifier: string | undefined): string | undefined {
  if (identifier === undefined) return undefined;
  if (/qwen3(?![.\d])|qwq|smollm3/i.test(identifier)) return "/no_think";
  if (/glm/i.test(identifier)) return "/nothink";
  return undefined;
}
