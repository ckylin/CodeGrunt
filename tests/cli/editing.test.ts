import { describe, it, expect } from 'vitest';
import {
  lineStart, lineEnd, cursorLineIndex, moveVertical, wordLeft, wordRight,
  deleteWordBefore, deleteToLineStart, deleteToLineEnd,
  visibleWindow, maxInputRows, buildRule,
} from '../../src/cli/ink/editing.js';

describe('line helpers', () => {
  const text = 'abc\nde\nfghi';

  it('lineStart / lineEnd bound the line containing the cursor', () => {
    expect(lineStart(text, 0)).toBe(0);
    expect(lineStart(text, 5)).toBe(4);
    expect(lineEnd(text, 5)).toBe(6);
    expect(lineEnd(text, 8)).toBe(text.length);
  });

  it('cursorLineIndex counts newlines before the cursor', () => {
    expect(cursorLineIndex(text, 0)).toBe(0);
    expect(cursorLineIndex(text, 4)).toBe(1);
    expect(cursorLineIndex(text, text.length)).toBe(2);
  });
});

describe('moveVertical', () => {
  const text = 'abcd\nef\nghijk';

  it('keeps the column when the target line is long enough', () => {
    expect(moveVertical(text, 1, 1)).toBe(6); // col 1 of "abcd" -> col 1 of "ef"
    expect(moveVertical(text, 6, 1)).toBe(9); // col 1 of "ef" -> col 1 of "ghijk"
  });

  it('clamps to the end of a shorter line', () => {
    expect(moveVertical(text, 3, 1)).toBe(7); // col 3 of "abcd" -> end of "ef"
    expect(moveVertical(text, 10, -1)).toBe(7); // col 2 of "ghijk" -> end of "ef"
  });

  it('returns null at the first and last line', () => {
    expect(moveVertical(text, 2, -1)).toBeNull();
    expect(moveVertical(text, text.length, 1)).toBeNull();
    expect(moveVertical('single', 3, -1)).toBeNull();
    expect(moveVertical('single', 3, 1)).toBeNull();
  });
});

describe('word movement', () => {
  const text = 'foo bar_baz  qux';

  it('wordLeft skips separators then the word', () => {
    expect(wordLeft(text, text.length)).toBe(13);
    expect(wordLeft(text, 13)).toBe(4);
    expect(wordLeft(text, 4)).toBe(0);
    expect(wordLeft(text, 0)).toBe(0);
  });

  it('wordRight skips separators then the word', () => {
    expect(wordRight(text, 0)).toBe(3);
    expect(wordRight(text, 3)).toBe(11);
    expect(wordRight(text, text.length)).toBe(text.length);
  });

  it('treats a run of CJK characters as one word', () => {
    expect(wordLeft('你好世界 test', 4)).toBe(0);
  });
});

describe('deletions', () => {
  it('deleteWordBefore removes the previous word', () => {
    expect(deleteWordBefore('foo bar', 7)).toEqual({ text: 'foo ', cursor: 4 });
    expect(deleteWordBefore('foo bar', 0)).toEqual({ text: 'foo bar', cursor: 0 });
  });

  it('deleteToLineStart removes back to the start of the current line only', () => {
    expect(deleteToLineStart('abc\ndef', 6)).toEqual({ text: 'abc\nf', cursor: 4 });
  });

  it('deleteToLineStart at a line start joins with the previous line', () => {
    expect(deleteToLineStart('abc\ndef', 4)).toEqual({ text: 'abcdef', cursor: 3 });
    expect(deleteToLineStart('abc', 0)).toEqual({ text: 'abc', cursor: 0 });
  });

  it('deleteToLineEnd removes to the end of the current line only', () => {
    expect(deleteToLineEnd('abc\ndef', 1)).toEqual({ text: 'a\ndef', cursor: 1 });
  });

  it('deleteToLineEnd at a line end joins with the next line', () => {
    expect(deleteToLineEnd('abc\ndef', 3)).toEqual({ text: 'abcdef', cursor: 3 });
    expect(deleteToLineEnd('abc', 3)).toEqual({ text: 'abc', cursor: 3 });
  });
});

describe('visibleWindow / maxInputRows', () => {
  it('shows everything when it fits', () => {
    expect(visibleWindow(3, 1, 5)).toEqual({ start: 0, end: 3 });
  });

  it('keeps the focus line inside the window and clamps at both ends', () => {
    expect(visibleWindow(30, 0, 7)).toEqual({ start: 0, end: 7 });
    expect(visibleWindow(30, 15, 7)).toEqual({ start: 12, end: 19 });
    expect(visibleWindow(30, 29, 7)).toEqual({ start: 23, end: 30 });
  });

  it('allows ~30% of the terminal with a floor of 5 rows', () => {
    expect(maxInputRows(24)).toBe(7);
    expect(maxInputRows(10)).toBe(5);
    expect(maxInputRows(100)).toBe(30);
  });
});

describe('buildRule', () => {
  it('is exactly `width` columns with and without a label', () => {
    expect(buildRule(20)).toHaveLength(20);
    const labelled = buildRule(20, 'skill');
    expect(labelled).toHaveLength(20);
    expect(labelled).toContain(' skill ');
    expect(labelled.startsWith('──')).toBe(true);
  });

  it('drops the label rather than overflowing a narrow terminal', () => {
    expect(buildRule(8, 'a very long label')).toBe('─'.repeat(8));
  });
});
