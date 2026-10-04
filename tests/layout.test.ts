import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visualRows } from '../src/ui/layout.js';
import * as layout from '../src/ui/layout.js';

test('visualRows counts a single short line as one row', () => {
  assert.equal(visualRows('hello', 80), 1);
});

test('visualRows counts an empty value as one row', () => {
  assert.equal(visualRows('', 80), 1);
});

test('visualRows counts each newline-separated line', () => {
  assert.equal(visualRows('a\nb\nc', 80), 3);
});

test('visualRows counts empty lines (blank rows) too', () => {
  assert.equal(visualRows('a\n\n\nb', 80), 4);
});

test('visualRows adds a row for each soft-wrap of a long line', () => {
  // 10 chars at width 4 -> ceil(10/4) = 3 rows.
  assert.equal(visualRows('0123456789', 4), 3);
});

test('visualRows wraps independently per logical line', () => {
  // "01234" -> ceil(5/4)=2 rows; "ab" -> 1 row => 3 total.
  assert.equal(visualRows('01234\nab', 4), 3);
});

test('visualRows treats a line exactly at width as one row', () => {
  assert.equal(visualRows('abcd', 4), 1);
});

test('visualRows is robust to zero/negative width', () => {
  // Guards to width 1: every char is its own row.
  assert.equal(visualRows('abc', 0), 3);
  assert.equal(visualRows('abc', -5), 3);
});

// ---------------------------------------------------------------------------
// Single-sourced height math helpers (planned — see src/ui/layout.ts).
//
// These encode the CURRENT inline math in App.tsx and Sidebar.tsx so that
// relocating it into pure helpers is behaviour-preserving. They reference the
// helpers through the `layout` namespace at RUNTIME (not static named imports)
// so that `tsc --noEmit` stays green for the whole project before the
// implementer adds them — a missing helper then fails THIS assertion with a
// clear message, instead of a project-wide type error. Each helper is captured
// into a locally-typed variable so its signature is also asserted here.
//
// Expected RED until the implementer adds: inputChrome, inputWidthFor,
// overlayRowsFor, bodyHeightFor, and the relocated blockHeightOf / scrollOffset.
// ---------------------------------------------------------------------------

/** Fail loudly (rather than throwing a bare TypeError) when a helper isn't exported yet. */
function helper<T>(name: string): T {
  const fn = (layout as Record<string, unknown>)[name];
  assert.equal(typeof fn, 'function', `src/ui/layout.ts must export a \`${name}\` helper`);
  return fn as T;
}

// --- inputChrome -----------------------------------------------------------
// From App.tsx:326 — `2 + 1 + (inputQuestion ? 1 : 0)` (borders ×2 + label + optional question line).

test('inputChrome is 3 rows with no question line (borders + label)', () => {
  const inputChrome = helper<(hasQuestion: boolean) => number>('inputChrome');
  assert.equal(inputChrome(false), 3);
});

test('inputChrome reserves a 4th row when a question line is present', () => {
  const inputChrome = helper<(hasQuestion: boolean) => number>('inputChrome');
  assert.equal(inputChrome(true), 4);
});

// --- inputWidthFor ---------------------------------------------------------
// From App.tsx:330 — `Math.max(1, (columns ?? 80) - 6)` (border 2 + paddingX 2 + marginLeft 2).

test('inputWidthFor subtracts the 6 columns of input chrome from the terminal width', () => {
  const inputWidthFor = helper<(columns: number) => number>('inputWidthFor');
  assert.equal(inputWidthFor(80), 74);
  assert.equal(inputWidthFor(100), 94);
});

test('inputWidthFor clamps to at least 1 column on a very narrow terminal', () => {
  const inputWidthFor = helper<(columns: number) => number>('inputWidthFor');
  assert.equal(inputWidthFor(3), 1);
  assert.equal(inputWidthFor(0), 1);
});

// --- overlayRowsFor --------------------------------------------------------
// From App.tsx:344-348 — quit=5, approval=6, input=inputChrome+inputLines, else=2.
// Modelled as a descriptor object so the helper has no React/Ink dependency.

test('overlayRowsFor reserves 5 rows for the quit confirmation', () => {
  const overlayRowsFor = helper<(d: unknown) => number>('overlayRowsFor');
  assert.equal(overlayRowsFor({ kind: 'quit' }), 5);
});

test('overlayRowsFor reserves 6 rows for the approval modal', () => {
  const overlayRowsFor = helper<(d: unknown) => number>('overlayRowsFor');
  assert.equal(overlayRowsFor({ kind: 'approval' }), 6);
});

test('overlayRowsFor reserves inputChrome + inputLines rows for the reply box', () => {
  const overlayRowsFor = helper<(d: unknown) => number>('overlayRowsFor');
  // No question, 1 typed line → 3 + 1 = 4.
  assert.equal(overlayRowsFor({ kind: 'input', inputChrome: 3, inputLines: 1 }), 4);
  // Question present, 5 typed lines → 4 + 5 = 9.
  assert.equal(overlayRowsFor({ kind: 'input', inputChrome: 4, inputLines: 5 }), 9);
});

test('overlayRowsFor reserves 2 rows for the default help bar', () => {
  const overlayRowsFor = helper<(d: unknown) => number>('overlayRowsFor');
  assert.equal(overlayRowsFor({ kind: 'list' }), 2);
});

// --- bodyHeightFor ---------------------------------------------------------
// From App.tsx:349 — `Math.max(6, rows - 2 - overlayRows)`.

test('bodyHeightFor is rows minus the header/safety rows minus the overlay', () => {
  const bodyHeightFor = helper<(rows: number, overlayRows: number) => number>('bodyHeightFor');
  assert.equal(bodyHeightFor(30, 2), 26); // 30 - 2 - 2
  assert.equal(bodyHeightFor(30, 6), 22); // 30 - 2 - 6
});

test('bodyHeightFor clamps to a minimum of 6 rows on a short terminal', () => {
  const bodyHeightFor = helper<(rows: number, overlayRows: number) => number>('bodyHeightFor');
  assert.equal(bodyHeightFor(10, 6), 6); // 10 - 2 - 6 = 2 → clamped to 6
});

// --- blockHeightOf (relocated from Sidebar.tsx:116-121) --------------------
// top-level block: marginTop(1) + optional header(1) + name(1) + template·cost(1).
// child block: marginTop(0) + no header + name(1) + template·cost(1).

test('blockHeightOf counts a top-level agent with a new project header as 4 rows', () => {
  const blockHeightOf =
    helper<(info: { parentId?: string; project: string }, prevProject: string | undefined) => number>(
      'blockHeightOf',
    );
  // marginTop 1 + header 1 (project differs from prev) + name 1 + cost 1 = 4.
  assert.equal(blockHeightOf({ project: 'p' }, undefined), 4);
});

test('blockHeightOf omits the header row when the project matches the previous top-level', () => {
  const blockHeightOf =
    helper<(info: { parentId?: string; project: string }, prevProject: string | undefined) => number>(
      'blockHeightOf',
    );
  // marginTop 1 + header 0 + name 1 + cost 1 = 3.
  assert.equal(blockHeightOf({ project: 'p' }, 'p'), 3);
});

test('blockHeightOf counts a nested child as 2 rows (no margin, no header)', () => {
  const blockHeightOf =
    helper<(info: { parentId?: string; project: string }, prevProject: string | undefined) => number>(
      'blockHeightOf',
    );
  // marginTop 0 + header 0 + name 1 + cost 1 = 2.
  assert.equal(blockHeightOf({ parentId: 'p1', project: 'p' }, 'p'), 2);
});

// --- scrollOffset (relocated from Sidebar.tsx:125-136) ---------------------

test('scrollOffset hides nothing while the selected block already fits', () => {
  const scrollOffset =
    helper<(blockHeights: number[], selectedIndex: number, listRows: number) => number>('scrollOffset');
  // Three 3-row blocks, 20 rows available — everything fits, so no scroll.
  assert.equal(scrollOffset([3, 3, 3], 2, 20), 0);
});

test('scrollOffset returns 0 for a negative selection', () => {
  const scrollOffset =
    helper<(blockHeights: number[], selectedIndex: number, listRows: number) => number>('scrollOffset');
  assert.equal(scrollOffset([3, 3, 3], -1, 20), 0);
});

test('scrollOffset advances by whole blocks until the selected one fits', () => {
  const scrollOffset =
    helper<(blockHeights: number[], selectedIndex: number, listRows: number) => number>('scrollOffset');
  // Blocks of height 4 each, only 8 rows visible. Selecting index 3 (4th block):
  // heightFrom(0,3)=16>8 → start=1; heightFrom(1,3)=12>8 → start=2; heightFrom(2,3)=8<=8 → stop.
  // Hidden = heightFrom(0, start-1=1) = 4 + 4 = 8.
  assert.equal(scrollOffset([4, 4, 4, 4], 3, 8), 8);
});
