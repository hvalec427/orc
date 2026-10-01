import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

/**
 * A small multi-line text input built directly on Ink's `useInput`.
 *
 * `ink-text-input` is single-line: when a value contains a newline it cannot
 * render it, which corrupts the surrounding bordered layout. That is why the
 * old code stripped every `\r`/`\n` out of the value — but that also made it
 * impossible to type (Alt/Shift+Enter) or paste multi-line prompts.
 *
 * This component keeps newlines in the value, renders the value across as many
 * `<Text>` rows as needed, and manages its own cursor:
 *   - plain Enter submits
 *   - Alt+Enter / Shift+Enter insert a newline
 *   - pasted text (delivered by Ink as one multi-character `input`) is inserted
 *     verbatim, newlines included
 */
export function MultilineInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  isActive = true,
  focusColor = 'cyan',
  maxLines,
  width,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  isActive?: boolean;
  focusColor?: string;
  /**
   * Maximum number of VISUAL rows to render at once. When the value occupies
   * more rows than this (including soft-wrapped long lines), the view scrolls to
   * keep the cursor's line visible. This caps the component's rendered height so
   * the surrounding layout can reserve a fixed number of rows — critical in a
   * TUI, where an output taller than the terminal scrolls the screen and
   * corrupts Ink's in-place redraw (flicker).
   */
  maxLines?: number;
  /**
   * Column width available to the text. Used to count how many rows a logical
   * line occupies once it soft-wraps, so the viewport bounds VISUAL rows rather
   * than logical lines.
   */
  width?: number;
}) {
  // Cursor offset into `value` (0..value.length).
  const [cursor, setCursor] = useState(value.length);

  const clamp = (n: number) => Math.max(0, Math.min(value.length, n));

  const insert = (text: string) => {
    const at = clamp(cursor);
    const next = value.slice(0, at) + text + value.slice(at);
    onChange(next);
    setCursor(at + text.length);
  };

  useInput(
    (input, key) => {
      // Escape is handled by the parent (cancel), so ignore it here.
      if (key.escape) return;

      // Plain Enter submits. A newline is requested with a modifier
      // (Alt/Shift+Enter) or arrives as a raw \r / \n inside `input`
      // (e.g. Alt+Enter is delivered as the sequence "\r").
      if (key.return) {
        if (key.meta || key.shift) {
          insert('\n');
          return;
        }
        onSubmit(value);
        return;
      }

      if (key.leftArrow) {
        setCursor((c) => clamp(c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => clamp(c + 1));
        return;
      }
      if (key.upArrow || key.downArrow) {
        moveVertically(key.upArrow ? -1 : 1);
        return;
      }

      if (key.backspace || key.delete) {
        deleteBackwards();
        return;
      }

      if (!input) return;

      // `input` may contain stray carriage returns/newlines from Alt+Enter or
      // from a pasted block. Normalise CRLF/CR to LF and insert as-is; this is
      // what enables multi-line paste to work.
      const normalized = input.replace(/\r\n|\r/g, '\n');
      insert(normalized);
    },
    { isActive },
  );

  function moveVertically(dir: -1 | 1) {
    const at = clamp(cursor);
    const before = value.slice(0, at);
    const lineStart = before.lastIndexOf('\n') + 1;
    const col = at - lineStart;

    if (dir === -1) {
      if (lineStart === 0) {
        setCursor(0);
        return;
      }
      const prevStart = value.lastIndexOf('\n', lineStart - 2) + 1;
      const prevLen = lineStart - 1 - prevStart;
      setCursor(prevStart + Math.min(col, prevLen));
    } else {
      const nextBreak = value.indexOf('\n', at);
      if (nextBreak === -1) {
        setCursor(value.length);
        return;
      }
      const nextStart = nextBreak + 1;
      const afterNext = value.indexOf('\n', nextStart);
      const nextLen = (afterNext === -1 ? value.length : afterNext) - nextStart;
      setCursor(nextStart + Math.min(col, nextLen));
    }
  }

  function deleteBackwards() {
    const at = clamp(cursor);
    if (at === 0) return;
    const next = value.slice(0, at - 1) + value.slice(at);
    onChange(next);
    setCursor(at - 1);
  }

  const showPlaceholder = value.length === 0 && placeholder;

  return (
    <Box flexDirection="column">
      {showPlaceholder ? (
        <Text dimColor wrap="wrap">
          {renderWithCursor('', 0, isActive, focusColor, placeholder)}
        </Text>
      ) : (
        renderLines(value, cursor, isActive, focusColor, maxLines, width)
      )}
    </Box>
  );
}

function renderLines(
  value: string,
  cursor: number,
  active: boolean,
  focusColor: string,
  maxLines?: number,
  width?: number,
) {
  const lines = value.split('\n');
  // Locate the (line, column) of the cursor.
  let remaining = cursor;
  let cursorLine = 0;
  let cursorCol = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.length;
    if (remaining <= len) {
      cursorLine = i;
      cursorCol = remaining;
      break;
    }
    remaining -= len + 1; // account for the '\n'
  }

  // How many VISUAL rows a logical line occupies once soft-wrapped at `width`.
  const rowsOf = (line: string) =>
    width && width > 0 ? Math.max(1, Math.ceil(line.length / width)) : 1;

  // Scroll a window of logical lines so that (a) the cursor's line stays visible
  // and (b) the window's total VISUAL rows never exceed `maxLines`. Counting
  // wrapped rows (not logical lines) is what keeps the frame from overflowing the
  // terminal — a single long line can wrap to several rows on its own.
  let start = 0;
  let windowed = lines;
  if (maxLines !== undefined) {
    const total = lines.reduce((n, l) => n + rowsOf(l), 0);
    if (total > maxLines) {
      // Grow the window upward from the cursor line, adding whole lines while
      // their wrapped rows still fit in the budget. The cursor's own line is
      // always included even if it alone exceeds the budget (its last rows stay
      // visible via wrap).
      let used = rowsOf(lines[cursorLine]!);
      let top = cursorLine;
      let bottom = cursorLine;
      // Prefer showing context below the cursor first, then above.
      while (bottom + 1 < lines.length && used + rowsOf(lines[bottom + 1]!) <= maxLines) {
        bottom += 1;
        used += rowsOf(lines[bottom]!);
      }
      while (top - 1 >= 0 && used + rowsOf(lines[top - 1]!) <= maxLines) {
        top -= 1;
        used += rowsOf(lines[top]!);
      }
      start = top;
      windowed = lines.slice(top, bottom + 1);
    }
  }

  // `wrap="wrap"` lets a logical line that is wider than the terminal soft-wrap
  // onto the next row instead of being truncated with an ellipsis. The window
  // above still bounds how many logical lines we render.
  return windowed.map((line, i) => {
    const lineIndex = start + i;
    return (
      <Text key={lineIndex} wrap="wrap">
        {lineIndex === cursorLine
          ? renderWithCursor(line, cursorCol, active, focusColor)
          : line || ' '}
      </Text>
    );
  });
}

function renderWithCursor(
  line: string,
  col: number,
  active: boolean,
  focusColor: string,
  placeholder?: string,
) {
  if (placeholder !== undefined) {
    // Placeholder: show the cursor on the first character when active.
    if (!active) return placeholder;
    return (
      <>
        <Text inverse color={focusColor}>
          {placeholder.charAt(0) || ' '}
        </Text>
        {placeholder.slice(1)}
      </>
    );
  }

  if (!active) return line || ' ';

  const head = line.slice(0, col);
  const at = line.charAt(col) || ' ';
  const tail = line.slice(col + 1);
  return (
    <>
      {head}
      <Text inverse color={focusColor}>
        {at}
      </Text>
      {tail}
    </>
  );
}
