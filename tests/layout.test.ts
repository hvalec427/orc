import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visualRows } from '../src/ui/layout.js';

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
