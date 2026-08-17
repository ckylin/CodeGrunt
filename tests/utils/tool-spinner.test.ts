import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { printToolOutputPreview, createToolSpinner } from '../../src/utils/tool-spinner.js';
import { registerSink, unregisterSink } from '../../src/cli/ink/output-channel.js';
import type { OutputChannelSink, LiveToolInfo } from '../../src/cli/ink/output-channel.js';

function makeMockSink(): OutputChannelSink & { lines: string[]; liveTool: (LiveToolInfo | null)[] } {
  const lines: string[] = [];
  const liveTool: (LiveToolInfo | null)[] = [];
  return {
    lines,
    liveTool,
    writeLine: (text: string) => { lines.push(text); },
    setLiveText: () => {},
    setLiveTool: (info) => { liveTool.push(info); },
  };
}

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
    unregisterSink(); // isolate from any sink left registered by another test file
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
    unregisterSink();
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

  it('routes to the sink as a single block instead of stdout when a sink is registered', () => {
    const sink = makeMockSink();
    registerSink(sink);
    printToolOutputPreview('line one\nline two\nline three');
    expect(written).toHaveLength(0); // nothing went to stdout
    expect(sink.lines).toHaveLength(1); // one cohesive block, not one write() per line
    const out = stripAnsi(sink.lines[0]);
    expect(out).toContain('line one');
    expect(out).toContain('line two');
    expect(out).toContain('line three');
  });

  it('shows output in sink mode even when process.stdout.isTTY is false (App only mounts against a real TTY, so this check is irrelevant there)', () => {
    const sink = makeMockSink();
    registerSink(sink);
    delete process.env['CODEGRUNT_FORCE_TOOL_OUTPUT'];
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    printToolOutputPreview('some output');
    expect(sink.lines).toHaveLength(1);
  });
});

describe('createToolSpinner — sink mode', () => {
  let sink: ReturnType<typeof makeMockSink>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sink = makeMockSink();
    registerSink(sink);
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    unregisterSink();
    writeSpy.mockRestore();
  });

  it('drives setLiveTool() instead of writing raw \\r bytes to stdout', () => {
    const spinner = createToolSpinner('read_file', { path: 'src/index.ts' });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(sink.liveTool.length).toBeGreaterThan(0);
    expect(sink.liveTool[0]?.name).toBe('read_file');
    expect(sink.liveTool[0]?.argPreview).toBe('src/index.ts');
    spinner.done(true, 5);
  });

  it('clears the live tool status (setLiveTool(null)) when done() is called', () => {
    const spinner = createToolSpinner('execute_shell', { command: 'npm test' });
    spinner.done(true, 100);
    expect(sink.liveTool[sink.liveTool.length - 1]).toBeNull();
  });

  it('writes a single completed-line entry to the sink on done(), not to stdout', () => {
    const spinner = createToolSpinner('write_file', { path: 'out.txt' });
    spinner.done(true, 42);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(sink.lines).toHaveLength(1);
    const line = stripAnsi(sink.lines[0]);
    expect(line).toContain('write_file');
    expect(line).toContain('out.txt');
    expect(line).toContain('42ms');
  });

  it('includes the error message on a failed tool call', () => {
    const spinner = createToolSpinner('execute_shell', { command: 'false' });
    spinner.done(false, 10, 'exit code 1');
    const line = stripAnsi(sink.lines[0]);
    expect(line).toContain('exit code 1');
  });
});
