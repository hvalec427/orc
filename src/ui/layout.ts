/**
 * Pure layout helpers for the TUI. Kept free of Ink imports so the row math can
 * be unit-tested without a terminal.
 */

/**
 * Count the number of terminal rows `value` occupies when rendered with
 * wrap="wrap" into a box `width` columns wide. Each logical line takes at least
 * one row and an extra row for every full `width` of characters beyond the
 * first — matching how the MultilineInput soft-wraps long lines.
 */
export function visualRows(value: string, width: number): number {
  const w = Math.max(1, width);
  let total = 0;
  for (const line of value.split('\n')) {
    total += Math.max(1, Math.ceil(line.length / w));
  }
  return total;
}
