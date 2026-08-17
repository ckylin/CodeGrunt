import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { printToolOutputPreview } from '../../src/utils/tool-spinner.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('printToolOutputPreview', () => {
  let written: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const originalIsTTY = process.stdout.isTTY;
  const originalHide = process.env['CODEGRUNT_HIDE_TOOL_OUTPUT'];
  const originalForce = process.env['CODEGRUNT_FORCE_TOOL_OUTPUT'];

  beforeEach(() => {
    written = [];
    // printToolOutputPreview gates on isTTY unless CODEGRUNT_FORCE_TOOL_OUTPUT
    // is set — force it here so the test doesn't depend on the runner's TTY.
    delete process.env['CODEGRUNT_HIDE_TOOL_OUTPUT'];
    process.env['CODEGRUNT_FORCE_TOOL_OUTPUT'] = '1';
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    if (originalHide === undefined) delete process.env['CODEGRUNT_HIDE_TOOL_OUTPUT'];
    else process.env['CODEGRUNT_HIDE_TOOL_OUTPUT'] = originalHide;
    if (originalForce === undefined) delete process.env['CODEGRUNT_FORCE_TOOL_OUTPUT'];
    else process.env['CODEGRUNT_FORCE_TOOL_OUTPUT'] = originalForce;
  });

  it('prints each line of short output prefixed with a bar', () => {
    printToolOutputPreview('line one\nline two');
    const out = stripAnsi(written.join(''));
    expect(out).toContain('line one');
    expect(out).toContain('line two');
  });

  it('does nothing for empty or whitespace-only output', () => {
    printToolOutputPreview('   \n  \n');
    expect(written).toHaveLength(0);
  });

  it('does nothing when CODEGRUNT_HIDE_TOOL_OUTPUT is set', () => {
    process.env['CODEGRUNT_HIDE_TOOL_OUTPUT'] = '1';
    printToolOutputPreview('some output');
    expect(written).toHaveLength(0);
  });

  it('does nothing when not a TTY and not forced', () => {
    delete process.env['CODEGRUNT_FORCE_TOOL_OUTPUT'];
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    printToolOutputPreview('some output');
    expect(written).toHaveLength(0);
  });

  it('shows the tail, not the head, when output exceeds the max line cap', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    printToolOutputPreview(lines.join('\n'));
    const out = stripAnsi(written.join(''));
    // Tail lines must be present.
    expect(out).toContain('line 19');
    expect(out).toContain('line 5'); // last 15 lines: 5..19
    // Head lines beyond the cap must be dropped.
    expect(out).not.toContain('line 0\n');
    expect(out).not.toContain('line 4\n');
  });

  it('reports how many lines were truncated', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    printToolOutputPreview(lines.join('\n'));
    const out = stripAnsi(written.join(''));
    expect(out).toContain('5 more lines');
  });

  it('clips an individual line that exceeds the max character width', () => {
    const longLine = 'x'.repeat(300);
    printToolOutputPreview(longLine);
    const out = stripAnsi(written.join(''));
    expect(out).toContain('…');
    expect(out).not.toContain('x'.repeat(201));
  });

  it('normalizes CRLF line endings before splitting', () => {
    printToolOutputPreview('a\r\nb\r\nc');
    const out = stripAnsi(written.join(''));
    const lineCount = out.split('\n').filter((l) => l.trim().length > 0).length;
    expect(lineCount).toBe(3);
  });

  it('strips trailing blank lines without affecting content', () => {
    printToolOutputPreview('only line\n\n\n');
    const out = stripAnsi(written.join(''));
    const contentLines = out.split('\n').filter((l) => l.trim().length > 0);
    expect(contentLines).toHaveLength(1);
    expect(contentLines[0]).toContain('only line');
  });
});
