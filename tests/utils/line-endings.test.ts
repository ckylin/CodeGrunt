import { describe, it, expect } from 'vitest';
import { findExactOrLineEndingTolerant, conformLineEndings } from '../../src/utils/line-endings.js';

describe('findExactOrLineEndingTolerant', () => {
  it('finds an exact match when there is no CRLF involved', () => {
    const match = findExactOrLineEndingTolerant('hello world', 'world');
    expect(match).not.toBe(null);
    expect(match).not.toBe('AMBIGUOUS');
    if (match && match !== 'AMBIGUOUS') {
      expect(match.start).toBe(6);
      expect(match.end).toBe(11);
      expect(match.matchedText).toBe('world');
    }
  });

  it('returns null when the needle is not present at all', () => {
    expect(findExactOrLineEndingTolerant('hello world', 'xyz')).toBeNull();
  });

  it('returns AMBIGUOUS for an exact needle appearing twice', () => {
    expect(findExactOrLineEndingTolerant('foo bar foo', 'foo')).toBe('AMBIGUOUS');
  });

  it('matches a plain-\\n needle against CRLF file content (the core Windows regression case)', () => {
    const haystack = 'line one\r\nline two\r\nline three';
    const needle = 'line one\nline two';
    const match = findExactOrLineEndingTolerant(haystack, needle);
    expect(match).not.toBeNull();
    expect(match).not.toBe('AMBIGUOUS');
    if (match && match !== 'AMBIGUOUS') {
      // matchedText must be the ORIGINAL (CRLF) substring, not the needle.
      expect(match.matchedText).toBe('line one\r\nline two');
      expect(haystack.slice(match.start, match.end)).toBe('line one\r\nline two');
    }
  });

  it('matches a CRLF needle against plain-\\n file content', () => {
    const haystack = 'line one\nline two\nline three';
    const needle = 'line one\r\nline two';
    const match = findExactOrLineEndingTolerant(haystack, needle);
    expect(match).not.toBeNull();
    expect(match).not.toBe('AMBIGUOUS');
    if (match && match !== 'AMBIGUOUS') {
      expect(match.matchedText).toBe('line one\nline two');
    }
  });

  it('leaves content outside the matched span untouched (offsets index into the original string)', () => {
    const haystack = 'prefix\r\nline one\r\nline two\r\nsuffix';
    const needle = 'line one\nline two';
    const match = findExactOrLineEndingTolerant(haystack, needle);
    expect(match).not.toBeNull();
    expect(match).not.toBe('AMBIGUOUS');
    if (match && match !== 'AMBIGUOUS') {
      const before = haystack.slice(0, match.start);
      const after = haystack.slice(match.end);
      expect(before).toBe('prefix\r\n');
      expect(after).toBe('\r\nsuffix');
    }
  });

  it('returns AMBIGUOUS when the CRLF-normalized needle appears twice', () => {
    const haystack = 'line one\r\nline two\r\nline one\nline two';
    const needle = 'line one\nline two';
    expect(findExactOrLineEndingTolerant(haystack, needle)).toBe('AMBIGUOUS');
  });

  it('returns null for a genuinely absent needle even when \\r is present elsewhere', () => {
    const haystack = 'line one\r\nline two';
    expect(findExactOrLineEndingTolerant(haystack, 'not present')).toBeNull();
  });
});

describe('conformLineEndings', () => {
  it('converts LF replacement to CRLF when the matched text was CRLF', () => {
    const result = conformLineEndings('new one\nnew two', 'old one\r\nold two');
    expect(result).toBe('new one\r\nnew two');
  });

  it('converts CRLF replacement to LF when the matched text was LF', () => {
    const result = conformLineEndings('new one\r\nnew two', 'old one\nold two');
    expect(result).toBe('new one\nnew two');
  });

  it('leaves replacement untouched when both are already LF', () => {
    const result = conformLineEndings('new one\nnew two', 'old one\nold two');
    expect(result).toBe('new one\nnew two');
  });

  it('leaves replacement untouched when both are already CRLF', () => {
    const result = conformLineEndings('new one\r\nnew two', 'old one\r\nold two');
    expect(result).toBe('new one\r\nnew two');
  });

  it('leaves a single-line replacement (no newlines) untouched regardless of matched style', () => {
    expect(conformLineEndings('single line', 'old\r\nold2')).toBe('single line');
  });
});
