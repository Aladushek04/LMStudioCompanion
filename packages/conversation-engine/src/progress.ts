/** Text progress rendering for compaction status lines. */

export function progressBar(fraction: number, width = 12): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Overall progress across chunks: `done` finished chunks out of `total`,
 * plus `within` (0..1) progress inside the current chunk.
 */
export function overallFraction(
  done: number,
  total: number,
  within: number,
): number {
  if (total <= 0) return 1;
  const clampedWithin = Math.min(1, Math.max(0, within));
  return Math.min(1, (done + clampedWithin) / total);
}
