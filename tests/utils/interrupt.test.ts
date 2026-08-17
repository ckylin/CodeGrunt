import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createInterruptController, getActiveInterruptCount } from '../../src/utils/interrupt.js';

function makeFakeStdin(overrides: Partial<{ isTTY: boolean; isRaw: boolean }> = {}) {
  const emitter = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
  };
  emitter.isTTY = overrides.isTTY ?? true;
  emitter.isRaw = overrides.isRaw ?? false;
  emitter.setRawMode = vi.fn((v: boolean) => { emitter.isRaw = v; });
  emitter.resume = vi.fn();
  emitter.pause = vi.fn();
  return emitter;
}

describe('createInterruptController', () => {
  const originalStdin = process.stdin;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  });

  it('aborts the signal on SIGINT and cleans up the listener', () => {
    Object.defineProperty(process, 'stdin', { value: makeFakeStdin({ isTTY: false }), configurable: true });
    const before = process.listenerCount('SIGINT');
    const ctrl = createInterruptController();
    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    process.emit('SIGINT');
    expect(ctrl.signal.aborted).toBe(true);

    ctrl.cleanup();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('tracks active controller count across nested create/cleanup', () => {
    Object.defineProperty(process, 'stdin', { value: makeFakeStdin({ isTTY: false }), configurable: true });
    const base = getActiveInterruptCount();
    const a = createInterruptController();
    expect(getActiveInterruptCount()).toBe(base + 1);
    const b = createInterruptController();
    expect(getActiveInterruptCount()).toBe(base + 2);
    a.cleanup();
    expect(getActiveInterruptCount()).toBe(base + 1);
    b.cleanup();
    expect(getActiveInterruptCount()).toBe(base);
  });

  it('does not touch stdin raw mode when stdin is not a TTY', () => {
    const fakeStdin = makeFakeStdin({ isTTY: false });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const ctrl = createInterruptController();
    expect(fakeStdin.setRawMode).not.toHaveBeenCalled();
    expect(fakeStdin.resume).not.toHaveBeenCalled();
    ctrl.cleanup();
    expect(fakeStdin.pause).not.toHaveBeenCalled();
  });

  it('enables raw mode and listens for data when stdin is a TTY, restoring on cleanup', () => {
    const fakeStdin = makeFakeStdin({ isTTY: true, isRaw: false });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const ctrl = createInterruptController();
    expect(fakeStdin.setRawMode).toHaveBeenCalledWith(true);
    expect(fakeStdin.resume).toHaveBeenCalled();

    ctrl.cleanup();
    expect(fakeStdin.setRawMode).toHaveBeenCalledWith(false);
    expect(fakeStdin.pause).toHaveBeenCalled();
  });

  it('aborts when ESC byte arrives on stdin data', () => {
    const fakeStdin = makeFakeStdin({ isTTY: true });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const ctrl = createInterruptController();
    fakeStdin.emit('data', '\x1b');
    expect(ctrl.signal.aborted).toBe(true);
    ctrl.cleanup();
  });

  it('aborts when Ctrl+C byte (0x03) arrives on stdin data', () => {
    const fakeStdin = makeFakeStdin({ isTTY: true });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const ctrl = createInterruptController();
    fakeStdin.emit('data', Buffer.from([0x03]));
    expect(ctrl.signal.aborted).toBe(true);
    ctrl.cleanup();
  });

  it('does not abort on a longer escape sequence that merely starts with ESC (e.g. arrow keys)', () => {
    const fakeStdin = makeFakeStdin({ isTTY: true });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const ctrl = createInterruptController();
    fakeStdin.emit('data', '\x1b[A'); // up arrow
    expect(ctrl.signal.aborted).toBe(false);
    ctrl.cleanup();
  });

  it('does not abort on a plain printable keystroke', () => {
    const fakeStdin = makeFakeStdin({ isTTY: true });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const ctrl = createInterruptController();
    fakeStdin.emit('data', 'a');
    expect(ctrl.signal.aborted).toBe(false);
    ctrl.cleanup();
  });

  it('does not restore raw mode on cleanup if it was already raw before this controller ran', () => {
    const fakeStdin = makeFakeStdin({ isTTY: true, isRaw: true });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const ctrl = createInterruptController();
    // Already raw — must not call setRawMode(true) again.
    expect(fakeStdin.setRawMode).not.toHaveBeenCalledWith(true);
    ctrl.cleanup();
    // And must not turn it off either, since this controller didn't turn it on.
    expect(fakeStdin.setRawMode).not.toHaveBeenCalledWith(false);
  });

  it('abort is idempotent — calling it twice only writes the newline once', () => {
    Object.defineProperty(process, 'stdin', { value: makeFakeStdin({ isTTY: false }), configurable: true });
    const ctrl = createInterruptController();
    process.emit('SIGINT');
    process.emit('SIGINT');
    expect(ctrl.signal.aborted).toBe(true);
    const newlineWrites = writeSpy.mock.calls.filter((c) => c[0] === '\n').length;
    expect(newlineWrites).toBe(1);
    ctrl.cleanup();
  });

  // Windows regression coverage: some terminal contexts (piped stdin
  // masquerading as a TTY, certain ConEmu/mintty setups) throw from
  // setRawMode where POSIX terminals wouldn't. This must degrade to
  // "Esc-to-cancel unavailable", not crash the agent turn.
  it('does not throw when setRawMode(true) throws during setup', () => {
    const fakeStdin = makeFakeStdin({ isTTY: true, isRaw: false });
    fakeStdin.setRawMode = vi.fn(() => { throw new Error('raw mode not supported here'); });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    expect(() => createInterruptController()).not.toThrow();
  });

  it('SIGINT abort still works even when raw-mode setup failed', () => {
    const fakeStdin = makeFakeStdin({ isTTY: true, isRaw: false });
    fakeStdin.setRawMode = vi.fn(() => { throw new Error('raw mode not supported here'); });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const ctrl = createInterruptController();
    process.emit('SIGINT');
    expect(ctrl.signal.aborted).toBe(true);
    ctrl.cleanup();
  });

  it('does not throw when setRawMode(false) throws during cleanup', () => {
    const fakeStdin = makeFakeStdin({ isTTY: true, isRaw: false });
    let calls = 0;
    fakeStdin.setRawMode = vi.fn(() => {
      calls++;
      if (calls > 1) throw new Error('cannot restore raw mode');
    });
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const ctrl = createInterruptController();
    expect(() => ctrl.cleanup()).not.toThrow();
  });
});
