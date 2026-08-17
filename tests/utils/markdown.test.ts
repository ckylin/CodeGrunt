import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MarkdownRenderer } from '../../src/utils/markdown.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('MarkdownRenderer code block wrapping', () => {
  const originalColumns = process.stdout.columns;

  beforeEach(() => {
    // Fix terminal width so wrap-width math is deterministic across CI/dev.
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true });
  });

  it('wraps a code line longer than the box width instead of truncating it', () => {
    const renderer = new MarkdownRenderer();
    const longLine = 'x'.repeat(80); // wider than the fixed 40-col terminal
    let out = renderer.feed('```\n' + longLine + '\n```\n');
    out += renderer.flush();
    const plain = stripAnsi(out);

    // No ellipsis — content must never be silently cut off.
    expect(plain).not.toContain('…');
    // Every character of the original line must survive somewhere in the output.
    expect(plain.replace(/[^x]/g, '').length).toBeGreaterThanOrEqual(longLine.length);
  });

  it('renders a short code line on a single row without wrapping', () => {
    const renderer = new MarkdownRenderer();
    let out = renderer.feed('```\nconst x = 1;\n```\n');
    out += renderer.flush();
    const plain = stripAnsi(out);
    const codeLines = plain.split('\n').filter(l => l.includes('const x = 1;'));
    expect(codeLines).toHaveLength(1);
  });

  it('preserves an empty line inside a code block as one blank row', () => {
    const renderer = new MarkdownRenderer();
    let out = renderer.feed('```\nfoo\n\nbar\n```\n');
    out += renderer.flush();
    const plain = stripAnsi(out);
    expect(plain).toContain('foo');
    expect(plain).toContain('bar');
  });
});
