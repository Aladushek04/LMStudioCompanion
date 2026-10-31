/**
 * Char-class aware fallback token estimator, used wherever an SDK-exact
 * count isn't available (planning fallbacks, tool-result budgeting): a flat
 * chars-per-token ratio badly under-truncates CJK/full-width text (~2
 * chars/token, not 4) and base64/hex blobs (~3, not 4) — by up to ~2x, which
 * can blow the context despite a "cap" being in effect.
 *
 * Note: a long unbroken run of plain ASCII letters/digits (no spaces or
 * punctuation) also matches the base64ish pattern and is classified at the
 * 3-chars/token rate, not the 4-chars/token "other" rate — prose and
 * identifiers with normal word breaks are unaffected, but a caller building
 * synthetic all-alnum test fixtures should account for this (it estimates
 * MORE conservatively than a flat 4:1 ASCII ratio would).
 */

/** CJK / full-width Unicode ranges (kept simple, not exhaustive). */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x9fff], // CJK punctuation, Hiragana/Katakana, CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
];

function isCjk(charCode: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (charCode >= lo && charCode <= hi) return true;
  }
  return false;
}

/** A run of 64+ consecutive base64ish chars is treated as encoded binary. */
const BASE64_RUN_RE = /[A-Za-z0-9+/=]{64,}/g;

/**
 * Fallback token estimate: classify each char as CJK (2 chars/token), part
 * of a long base64ish run (3 chars/token), or other (4 chars/token), and sum
 * the per-class costs. Deterministic; empty string is 0.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const inBase64Run = new Uint8Array(text.length);
  BASE64_RUN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BASE64_RUN_RE.exec(text)) !== null) {
    inBase64Run.fill(1, match.index, match.index + match[0].length);
  }
  let cjk = 0;
  let base64Run = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (inBase64Run[i]) {
      base64Run++;
    } else if (isCjk(text.charCodeAt(i))) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 2 + base64Run / 3 + other / 4);
}

/** Per-message template overhead (role tags, separators) in the estimate. */
export const MESSAGE_OVERHEAD_TOKENS = 8;

/**
 * Estimate of what one message costs in the prompt: its text (including
 * any inline reasoning the engine keeps in the history), tool-call names
 * and arguments, tool results, plus a small per-message template overhead.
 * Used where an exact count is not available synchronously — the per-round
 * fit guard inside a tool pass.
 */
export function estimateMessageTokens(m: {
  text: string;
  toolCalls?: { name: string; args: string }[];
  toolResults?: { content: string }[];
}): number {
  let total = estimateTokens(m.text) + MESSAGE_OVERHEAD_TOKENS;
  for (const c of m.toolCalls ?? []) {
    total += estimateTokens(c.name) + estimateTokens(c.args) + 4;
  }
  for (const r of m.toolResults ?? []) {
    total += estimateTokens(r.content) + 4;
  }
  return total;
}

/**
 * How many chars of THIS text fit in maxTokens, given its own char mix —
 * the inverse of estimateTokens, scaled by the text's actual chars/token
 * density rather than a flat ratio.
 */
export function charBudget(text: string, maxTokens: number): number {
  return Math.floor(
    maxTokens * (text.length / Math.max(1, estimateTokens(text))),
  );
}
