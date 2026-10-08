import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerSink, unregisterSink, hasSink,
  write, appendLiveText, setLiveTextDirect, commitLiveText, discardLiveText, setLiveTool,
} from '../../src/core/output/output-channel.js';
import type { OutputChannelSink } from '../../src/core/output/output-channel.js';

function makeMockSink(): OutputChannelSink & {
  lines: string[];
  liveText: string[];
  liveTool: (import('../../src/core/output/output-channel.js').LiveToolInfo | null)[];
} {
  const lines: string[] = [];
  const liveText: string[] = [];
  const liveTool: (import('../../src/core/output/output-channel.js').LiveToolInfo | null)[] = [];
  return {
    lines,
    liveText,
    liveTool,
    writeLine: (text: string) => { lines.push(text); },
    setLiveText: (text: string) => { liveText.push(text); },
    setLiveTool: (info) => { liveTool.push(info); },
  };
}

describe('output-channel fallback mode (no sink registered)', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    unregisterSink();
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('hasSink() is false with no sink registered', () => {
    expect(hasSink()).toBe(false);
  });

  it('write() falls through to process.stdout.write unchanged', () => {
    write('hello\n');
    expect(writeSpy).toHaveBeenCalledWith('hello\n');
  });

  it('appendLiveText() falls through to process.stdout.write per delta (identical to old UIStreamEmitter behavior)', () => {
    appendLiveText('foo');
    appendLiveText('bar');
    expect(writeSpy.mock.calls.map(c => c[0])).toEqual(['foo', 'bar']);
  });

  it('setLiveTool() is a no-op in fallback mode (tool-spinner.ts owns its own stdout path)', () => {
    setLiveTool({ name: 'read_file', argPreview: 'x.ts', frame: '⠋', elapsedMs: 0 });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('setLiveTextDirect() is a no-op in fallback mode (no sink to render into, and stdout is append-only)', () => {
    setLiveTextDirect('some rendered text');
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('output-channel sink mode (registered sink)', () => {
  beforeEach(() => {
    unregisterSink();
    vi.useFakeTimers();
  });

  afterEach(() => {
    unregisterSink();
    vi.useRealTimers();
  });

  it('hasSink() is true once a sink is registered', () => {
    registerSink(makeMockSink());
    expect(hasSink()).toBe(true);
  });

  it('hasSink() is false again after unregisterSink()', () => {
    registerSink(makeMockSink());
    unregisterSink();
    expect(hasSink()).toBe(false);
  });

  it('write() routes to sink.writeLine instead of stdout', () => {
    const sink = makeMockSink();
    registerSink(sink);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    write('a complete block\n');
    expect(sink.lines).toEqual(['a complete block\n']);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('appendLiveText() renders the first delta immediately, then throttles bursts to a single trailing render with the FULL buffer', () => {
    const sink = makeMockSink();
    registerSink(sink);
    appendLiveText('Hello');
    // First call always renders immediately (no prior render to throttle against).
    expect(sink.liveText).toEqual(['Hello']);
    appendLiveText(', world');
    appendLiveText('!');
    // Still within the throttle window — no additional renders queued yet.
    expect(sink.liveText).toEqual(['Hello']);
    vi.advanceTimersByTime(50);
    // Trailing render fires once, with the fully-accumulated buffer.
    expect(sink.liveText).toEqual(['Hello', 'Hello, world!']);
  });

  it('appendLiveText() renders immediately again once the throttle window has elapsed', () => {
    const sink = makeMockSink();
    registerSink(sink);
    appendLiveText('a');
    vi.advanceTimersByTime(50);
    appendLiveText('b');
    expect(sink.liveText).toEqual(['a', 'ab']);
  });

  it('commitLiveText() writes the accumulated buffer as a permanent line and clears live text', () => {
    const sink = makeMockSink();
    registerSink(sink);
    appendLiveText('streamed response');
    commitLiveText();
    expect(sink.lines).toEqual(['streamed response']);
    expect(sink.liveText[sink.liveText.length - 1]).toBe('');
  });

  it('commitLiveText() cancels a pending throttled render so it cannot repopulate live text after clearing', () => {
    const sink = makeMockSink();
    registerSink(sink);
    appendLiveText('a');       // renders immediately
    appendLiveText('b');       // schedules a trailing render for 'ab'
    commitLiveText();          // should cancel that pending render
    vi.advanceTimersByTime(50);
    expect(sink.liveText[sink.liveText.length - 1]).toBe('');
  });

  it('commitLiveText() with no accumulated text does not push an empty history entry', () => {
    const sink = makeMockSink();
    registerSink(sink);
    commitLiveText();
    expect(sink.lines).toEqual([]);
  });

  it('discardLiveText() clears the buffer WITHOUT writing a history entry (abort case)', () => {
    const sink = makeMockSink();
    registerSink(sink);
    appendLiveText('partial text before abort');
    discardLiveText();
    expect(sink.lines).toEqual([]);
    expect(sink.liveText[sink.liveText.length - 1]).toBe('');
  });

  it('a fresh appendLiveText() after commitLiveText() starts a new buffer, not appended to the old one', () => {
    const sink = makeMockSink();
    registerSink(sink);
    appendLiveText('turn one');
    commitLiveText();
    appendLiveText('turn two');
    expect(sink.liveText[sink.liveText.length - 1]).toBe('turn two');
    expect(sink.lines).toEqual(['turn one']);
  });

  it('setLiveTextDirect() replaces the buffer exactly (no accumulation), unlike appendLiveText()', () => {
    const sink = makeMockSink();
    registerSink(sink);
    setLiveTextDirect('rendered block v1');
    vi.advanceTimersByTime(50); // clear the throttle window between the two calls
    setLiveTextDirect('rendered block v1 and v2');
    expect(sink.liveText).toEqual(['rendered block v1', 'rendered block v1 and v2']);
  });

  it('commitLiveText() also finalizes a buffer set via setLiveTextDirect() (not just appendLiveText())', () => {
    const sink = makeMockSink();
    registerSink(sink);
    setLiveTextDirect('a fully-rendered live block');
    commitLiveText();
    expect(sink.lines).toEqual(['a fully-rendered live block']);
  });

  it('setLiveTool() forwards the info object to the sink', () => {
    const sink = makeMockSink();
    registerSink(sink);
    const info = { name: 'execute_shell', argPreview: 'npm test', frame: '⠙', elapsedMs: 1200 };
    setLiveTool(info);
    expect(sink.liveTool).toEqual([info]);
  });

  it('setLiveTool(null) forwards null to clear the sink state', () => {
    const sink = makeMockSink();
    registerSink(sink);
    setLiveTool({ name: 'x', argPreview: 'y', frame: '⠋', elapsedMs: 0 });
    setLiveTool(null);
    expect(sink.liveTool[sink.liveTool.length - 1]).toBeNull();
  });
});
