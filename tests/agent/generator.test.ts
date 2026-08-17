import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UIStreamEmitter } from '../../src/core/agent/generator.js';
import { registerSink, unregisterSink } from '../../src/cli/ink/output-channel.js';
import type { OutputChannelSink, LiveToolInfo } from '../../src/cli/ink/output-channel.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeMockSink(): OutputChannelSink & { lines: string[]; liveText: string[] } {
  const lines: string[] = [];
  const liveText: string[] = [];
  return {
    lines,
    liveText,
    writeLine: (text: string) => { lines.push(text); },
    setLiveText: (text: string) => { liveText.push(text); },
    setLiveTool: (_info: LiveToolInfo | null) => {},
  };
}

describe('UIStreamEmitter — fallback mode (no sink, one-shot CLI)', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    unregisterSink();
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('writes text deltas directly to stdout (unchanged pre-existing behavior)', () => {
    const emitter = new UIStreamEmitter(0);
    emitter.onTextDelta('hello world\n');
    const written = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(stripAnsi(written)).toContain('hello world');
  });

  it('onFinish flushes any remaining buffered (non-newline-terminated) text', () => {
    const emitter = new UIStreamEmitter(0);
    emitter.onTextDelta('no trailing newline');
    writeSpy.mockClear();
    emitter.onFinish('stop');
    const written = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(stripAnsi(written)).toContain('no trailing newline');
  });
});

describe('UIStreamEmitter — sink mode (persistent App mounted)', () => {
  let sink: ReturnType<typeof makeMockSink>;

  beforeEach(() => {
    sink = makeMockSink();
    registerSink(sink);
  });

  afterEach(() => {
    unregisterSink();
  });

  it('routes text deltas to the sink live-text buffer instead of stdout', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const emitter = new UIStreamEmitter(0);
    emitter.onTextDelta('streaming response');
    expect(writeSpy).not.toHaveBeenCalled();
    expect(sink.liveText[sink.liveText.length - 1]).toContain('streaming response');
    writeSpy.mockRestore();
  });

  it('re-renders the FULL accumulated text on each delta (not just the new fragment)', () => {
    const emitter = new UIStreamEmitter(0);
    emitter.onTextDelta('Hello');
    emitter.onTextDelta(', world');
    emitter.onTextDelta('!');
    const last = sink.liveText[sink.liveText.length - 1];
    expect(stripAnsi(last)).toBe('Hello, world!');
  });

  it('renders a code block once its closing fence arrives, even split across deltas', () => {
    const emitter = new UIStreamEmitter(0);
    emitter.onTextDelta('```js\nconst x = 1;\n```\n');
    const last = sink.liveText[sink.liveText.length - 1];
    expect(stripAnsi(last)).toContain('╭');
    expect(stripAnsi(last)).toContain('const x = 1;');
  });

  it('shows no live preview for a code block that has not yet closed (MarkdownRenderer buffers until the closing fence, in both sink and fallback mode)', () => {
    const emitter = new UIStreamEmitter(0);
    emitter.onTextDelta('```js\nconst x = 1;\n');
    const last = sink.liveText[sink.liveText.length - 1];
    expect(stripAnsi(last)).toBe('');
  });

  it('onFinish commits the live buffer as a permanent history line', () => {
    const emitter = new UIStreamEmitter(0);
    emitter.onTextDelta('final response text');
    emitter.onFinish('stop');
    expect(sink.lines.length).toBe(1);
    expect(stripAnsi(sink.lines[0])).toContain('final response text');
  });

  it('does not write anything to stdout at all in sink mode', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const emitter = new UIStreamEmitter(0);
    emitter.onTextDelta('some text');
    emitter.onFinish('stop');
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});
