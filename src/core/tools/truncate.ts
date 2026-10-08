// Shared truncation for tool output. Two independent limits (lines, bytes),
// whichever is hit first wins. Never returns partial lines, except when a
// single trailing line alone exceeds the byte limit (tail truncation).

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const MAX_MATCH_LINE_CHARS = 500;

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

function untruncated(content: string, lines: string[], totalBytes: number): TruncationResult {
  return {
    content,
    truncated: false,
    truncatedBy: null,
    totalLines: lines.length,
    totalBytes,
    outputLines: lines.length,
    outputBytes: totalBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
  };
}

/** Keep the first N lines/bytes (file reads: the beginning matters). */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = byteLen(content);
  const lines = splitLines(content);

  if (lines.length <= maxLines && totalBytes <= maxBytes) return untruncated(content, lines, totalBytes);

  if (byteLen(lines[0]) > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines: lines.length,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
    };
  }

  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = byteLen(lines[i]) + (i > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    kept.push(lines[i]);
    bytes += lineBytes;
  }

  const out = kept.join('\n');
  return {
    content: out,
    truncated: true,
    truncatedBy,
    totalLines: lines.length,
    totalBytes,
    outputLines: kept.length,
    outputBytes: byteLen(out),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
  };
}

/** Keep the last N lines/bytes (shell output: errors and results come last). */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = byteLen(content);
  const lines = splitLines(content);

  if (lines.length <= maxLines && totalBytes <= maxBytes) return untruncated(content, lines, totalBytes);

  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const lineBytes = byteLen(lines[i]) + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      if (kept.length === 0) {
        const partial = tailBytes(lines[i], maxBytes);
        kept.unshift(partial);
        bytes = byteLen(partial);
        lastLinePartial = true;
      }
      break;
    }
    kept.unshift(lines[i]);
    bytes += lineBytes;
  }

  const out = kept.join('\n');
  return {
    content: out,
    truncated: true,
    truncatedBy,
    totalLines: lines.length,
    totalBytes,
    outputLines: kept.length,
    outputBytes: byteLen(out),
    lastLinePartial,
    firstLineExceedsLimit: false,
  };
}

function tailBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  // Skip UTF-8 continuation bytes so we never cut a character in half.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf-8');
}

export function truncateLine(line: string, maxChars = MAX_MATCH_LINE_CHARS): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
