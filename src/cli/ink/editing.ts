import stringWidth from 'string-width';

// Pure text-editing helpers for PromptInput. Everything works on a flat string
// plus a cursor index; "line" means a '\n'-delimited logical line.

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

export function lineStart(text: string, cursor: number): number {
  return cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1;
}

export function lineEnd(text: string, cursor: number): number {
  const i = text.indexOf('\n', cursor);
  return i === -1 ? text.length : i;
}

export function cursorLineIndex(text: string, cursor: number): number {
  let n = 0;
  for (let i = 0; i < cursor; i++) if (text[i] === '\n') n++;
  return n;
}

/** New cursor index one logical line up/down, keeping the column; null when there is no such line. */
export function moveVertical(text: string, cursor: number, delta: -1 | 1): number | null {
  const start = lineStart(text, cursor);
  const col = cursor - start;
  if (delta < 0) {
    if (start === 0) return null;
    const prevEnd = start - 1;
    const prevStart = lineStart(text, prevEnd);
    return prevStart + Math.min(col, prevEnd - prevStart);
  }
  const end = lineEnd(text, cursor);
  if (end >= text.length) return null;
  const nextStart = end + 1;
  return nextStart + Math.min(col, lineEnd(text, nextStart) - nextStart);
}

export function wordLeft(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isWordChar(text[i - 1])) i--;
  while (i > 0 && isWordChar(text[i - 1])) i--;
  return i;
}

export function wordRight(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && !isWordChar(text[i])) i++;
  while (i < text.length && isWordChar(text[i])) i++;
  return i;
}

export interface EditResult {
  text: string;
  cursor: number;
}

function cut(text: string, from: number, to: number): EditResult {
  return { text: text.slice(0, from) + text.slice(to), cursor: from };
}

export function deleteWordBefore(text: string, cursor: number): EditResult {
  return cut(text, wordLeft(text, cursor), cursor);
}

/** Delete back to the start of the line; at a line start, join with the previous line. */
export function deleteToLineStart(text: string, cursor: number): EditResult {
  const start = lineStart(text, cursor);
  return cut(text, cursor === start && cursor > 0 ? cursor - 1 : start, cursor);
}

/** Delete to the end of the line; at a line end, join with the next line. */
export function deleteToLineEnd(text: string, cursor: number): EditResult {
  const end = lineEnd(text, cursor);
  return cut(text, cursor, cursor === end && end < text.length ? end + 1 : end);
}

/** Visible slice [start, end) of `total` rows, kept around `focus`. */
export function visibleWindow(total: number, focus: number, size: number): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total };
  const start = Math.min(Math.max(focus - Math.floor(size / 2), 0), total - size);
  return { start, end: start + size };
}

/** Input box grows with content but never past ~30% of the terminal (min 5 rows). */
export function maxInputRows(terminalRows: number): number {
  return Math.max(5, Math.floor(terminalRows * 0.3));
}

/** Horizontal rule exactly `width` columns wide, with an optional inline label. */
export function buildRule(width: number, label?: string): string {
  const w = Math.max(width, 4);
  if (!label) return '─'.repeat(w);
  const text = ` ${label} `;
  const textWidth = stringWidth(text);
  if (textWidth + 4 > w) return '─'.repeat(w);
  return '──' + text + '─'.repeat(w - 2 - textWidth);
}
