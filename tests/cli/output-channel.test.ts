import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerSink, unregisterSink, hasSink,
  write, appendLiveText, setLiveTextDirect, commitLiveText, discardLiveText, setLiveTool,
} from '../../src/cli/ink/output-channel.js';
import type { OutputChannelSink } from '../../src/cli/ink/output-channel.js';

function makeMockSink(): OutputChannelSink & {
  lines: string[];
  liveText: string[];
  liveTool: (import('../../src/cli/ink/output-channel.js').LiveToolInfo | null)[];
} {
  const lines: string[] = [];
  const liveText: string[] = [];
  const liveTool: (import('../../src/cli/ink/output-channel.js').LiveToolInfo | null)[] = [];
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
  });

  afterEach(() => {
    unregisterSink();
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

  it('appendLiveText() accumulates deltas and pushes the FULL buffer each time, not just the delta', () => {
    const sink = makeMockSink();
    registerSink(sink);
    appendLiveText('Hello');
    appendLiveText(', world');
    appendLiveText('!');
    expect(sink.liveText).toEqual(['Hello', 'Hello, world', 'Hello, world!']);
  });

  it('commitLiveText() writes the accumulated buffer as a permanent line and clears live text', () => {
    const sink = makeMockSink();
    registerSink(sink);
    appendLiveText('streamed response');
    commitLiveText();
    expect(sink.lines).toEqual(['streamed response']);
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
