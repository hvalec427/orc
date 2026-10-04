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

/**
 * Rows of chrome around the reply input: box borders (2) + the "reply to" label (1)
 * plus an optional question line (1). Mirrors the InputBar layout.
 */
export function inputChrome(hasQuestion: boolean): number {
  return 2 + 1 + (hasQuestion ? 1 : 0);
}

/**
 * Columns available to the typed text inside the InputBar: full terminal width minus
 * the box border (2) + paddingX (2) + the input's marginLeft (2). Clamped to >= 1.
 */
export function inputWidthFor(columns: number): number {
  return Math.max(1, columns - 6);
}

/** Descriptor for the bottom overlay, decoupled from any Ink/React dependency. */
export type OverlayDescriptor =
  | { kind: 'quit' }
  | { kind: 'approval' }
  | { kind: 'input'; inputChrome: number; inputLines: number }
  | { kind: string };

/**
 * Rows reserved for the bottom overlay. Must equal the occupant's real rendered
 * height: quit=5, approval=6, input=inputChrome+inputLines, anything else (help bar)=2.
 */
export function overlayRowsFor(descriptor: OverlayDescriptor): number {
  switch (descriptor.kind) {
    case 'quit':
      return 5;
    case 'approval':
      return 6;
    case 'input': {
      const d = descriptor as { inputChrome: number; inputLines: number };
      return d.inputChrome + d.inputLines;
    }
    default:
      return 2;
  }
}

/**
 * Height of the main body row: the terminal rows minus the header/safety rows (2)
 * minus the overlay, clamped to a usable minimum of 6.
 */
export function bodyHeightFor(rows: number, overlayRows: number): number {
  return Math.max(6, rows - 2 - overlayRows);
}

/**
 * Rendered height (in rows) of one agent block in the sidebar: optional project header +
 * name + cost line, plus the top margin that separates top-level agents. Mirrors AgentRow's
 * layout. `prevProject` is the project of the nearest preceding top-level agent (for header
 * detection).
 */
export function blockHeightOf(
  info: { parentId?: string; project: string },
  prevProject: string | undefined,
): number {
  const isChild = info.parentId !== undefined;
  const marginTop = isChild ? 0 : 1;
  const header = !isChild && info.project !== prevProject ? 1 : 0;
  return marginTop + header + 1 /* name */ + 1 /* template·cost */;
}

/**
 * Smallest number of leading rows to hide so the selected block fits within `listRows`.
 * Scrolls by whole agent blocks: accumulate hidden rows until the selected block's bottom
 * is in view.
 */
export function scrollOffset(
  blockHeights: number[],
  selectedIndex: number,
  listRows: number,
): number {
  if (selectedIndex < 0) return 0;
  let start = 0; // first visible block index
  const heightFrom = (from: number, to: number) => {
    let h = 0;
    for (let i = from; i <= to; i++) h += blockHeights[i] ?? 0;
    return h;
  };
  // Advance the window start until the selected block's cumulative height fits.
  while (start < selectedIndex && heightFrom(start, selectedIndex) > listRows) start++;
  return heightFrom(0, start - 1);
}
