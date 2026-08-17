import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { printPaged } from '../../src/utils/pager.js';

function makeFakeStdin() {
  const emitter = new EventEmitter() as EventEmitter & {
    isRaw: boolean;
    setRawMode: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
  };
  emitter.isRaw = false;
  emitter.setRawMode = vi.fn((v: boolean) => { emitter.isRaw = v; });
  emitter.resume = vi.fn();
  emitter.pause = vi.fn();
  return emitter;
}

describe('printPaged', () => {
  let written: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const originalStdin = process.stdin;

  beforeEach(() => {
    written = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  });

  it('prints everything in one shot when not a TTY (piped output, CI)', async () => {
    await printPaged('line1\nline2\nline3', { isTTY: false, rows: 2 });
    expect(written.join('')).toBe('line1\nline2\nline3\n');
  });

  it('prints everything in one shot when content fits within one screen', async () => {
    await printPaged('line1\nline2', { isTTY: true, rows: 24 });
    expect(written.join('')).toBe('line1\nline2\n');
  });

  it('pages long content, waiting for a keypress between pages', async () => {
    const fakeStdin = makeFakeStdin();
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    // rows=3 → pageSize=2 (one row reserved for the prompt). 5 lines → 3 pages.
    const content = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const promise = printPaged(content, { isTTY: true, rows: 3 });

    // First page ("a\nb\n") should already be written, then a "-- more --"
    // prompt is showing and printPaged is awaiting a keypress.
    await Promise.resolve(); // let the first synchronous writes flush
    expect(written.join('')).toContain('a\nb\n');
    expect(written.join('')).toContain('-- more');

    fakeStdin.emit('data', ' ');
    await Promise.resolve();
    expect(written.join('')).toContain('c\nd\n');

    fakeStdin.emit('data', ' ');
    await promise;
    expect(written.join('')).toContain('e\n');
  });

  it('stops paging early when the user presses q', async () => {
    const fakeStdin = makeFakeStdin();
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    const content = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const promise = printPaged(content, { isTTY: true, rows: 3 });

    await Promise.resolve();
    fakeStdin.emit('data', 'q');
    await promise;

    // Only the first page should have been printed — 'e' never shown.
    expect(written.join('')).not.toContain('e\n');
  });

  it('falls back to printing everything if setRawMode throws (Windows terminal edge case)', async () => {
    const fakeStdin = makeFakeStdin();
    fakeStdin.setRawMode = vi.fn(() => { throw new Error('raw mode unsupported'); });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    const content = ['a', 'b', 'c', 'd', 'e'].join('\n');
    // Must resolve (not hang) even though the "keypress" can never actually arrive.
    await printPaged(content, { isTTY: true, rows: 3 });
    expect(written.join('')).toContain('e\n');
  });
});
