import { describe, it, expect } from 'vitest';
import { __testing } from '../../src/cli/ink/useHistory.js';

const { decodeHistoryLine, encodeHistoryLine } = __testing;

describe('history line encode/decode', () => {
  it('round-trips a single-line entry', () => {
    const encoded = encodeHistoryLine('fix the bug in auth.ts');
    expect(decodeHistoryLine(encoded)).toBe('fix the bug in auth.ts');
  });

  it('round-trips a multi-line entry (the reason JSONL replaced plain-text storage)', () => {
    const entry = 'line one\nline two\nline three';
    const encoded = encodeHistoryLine(entry);
    expect(decodeHistoryLine(encoded)).toBe(entry);
  });

  it('encodes a multi-line entry as a single line on disk (no embedded literal newline)', () => {
    const encoded = encodeHistoryLine('a\nb');
    expect(encoded).not.toContain('\n');
    expect(encoded.split('\n')).toHaveLength(1);
  });

  it('decodes a legacy plain-text line (no leading quote) as a passthrough', () => {
    // Pre-v0.9 history files stored entries as raw, unquoted text.
    expect(decodeHistoryLine('legacy plain entry')).toBe('legacy plain entry');
  });

  it('decodes a legacy line starting with a slash command correctly', () => {
    expect(decodeHistoryLine('/model deepseek-v4-pro')).toBe('/model deepseek-v4-pro');
  });

  it('returns null for a truly empty line', () => {
    expect(decodeHistoryLine('')).toBeNull();
  });

  it('strips a trailing carriage return (Windows-written file read on any platform)', () => {
    expect(decodeHistoryLine('legacy entry\r')).toBe('legacy entry');
    expect(decodeHistoryLine(encodeHistoryLine('quoted entry') + '\r')).toBe('quoted entry');
  });

  it('falls back to raw passthrough for a line that starts with a quote but is not valid JSON', () => {
    // Guards against a corrupted/truncated JSONL line crashing history load.
    expect(decodeHistoryLine('"unterminated')).toBe('"unterminated');
  });

  it('does not decode a JSON-encoded non-string value (e.g. a stray number) as a history entry', () => {
    expect(decodeHistoryLine('42')).toBe('42'); // no leading quote → legacy passthrough, correct
  });
});
