export interface InterruptController {
  signal: AbortSignal;
  cleanup: () => void;
  /** Manually trigger the same abort path SIGINT/Esc would — used by the
   *  persistent-App REPL mode, where PromptInput's onCancelBusy callback
   *  (not this module's own stdin listener) is what observes the keypress. */
  abort: () => void;
}

export interface InterruptControllerOptions {
  /**
   * When true (the default — matches all pre-existing call sites), this
   * controller puts stdin into raw mode itself and listens for Esc/Ctrl+C
   * bytes directly. That was necessary because PromptInput (the only other
   * thing with an active useInput() hook) used to unmount entirely for the
   * duration of the agent run, so nothing else was listening.
   *
   * Set to false once a persistent <App> component is mounted for the whole
   * REPL session (rather than being torn down and rebuilt every turn) — Ink
   * already owns stdin's raw mode continuously in that mode, and a SECOND
   * raw-mode manager fighting over the same stdin causes exactly the kind of
   * "which one wins" conflict this option exists to avoid. In that mode,
   * PromptInput's own useInput() sees Esc/Ctrl+C while busy and reports them
   * via onCancelBusy, which should call the returned controller's `abort()`
   * directly instead of this module reaching for stdin on its own.
   *
   * SIGINT handling is unaffected either way — it's a process-level signal,
   * not a stdin byte stream, so it doesn't conflict with Ink's raw mode.
   */
  manageStdin?: boolean;
}

// Track active interrupt controllers so the global SIGINT handler in repl.ts
// can distinguish between "abort current task" and "exit the REPL entirely".
let activeCount = 0;
export function getActiveInterruptCount(): number {
  return activeCount;
}

export function createInterruptController(options: InterruptControllerOptions = {}): InterruptController {
  const { manageStdin = true } = options;
  const controller = new AbortController();

  activeCount++;

  const abort = (): void => {
    if (controller.signal.aborted) return;
    process.stdout.write('\n');
    controller.abort();
  };

  const sigintHandler = (): void => abort();
  process.on('SIGINT', sigintHandler);

  // ── Escape-to-cancel (manageStdin mode only) ───────────────────────────
  // The "Thinking... (Esc to cancel)" hint shown during generation (see
  // UIStreamEmitter in generator.ts) needs a real key listener. Historically
  // Ink's PromptInput — the only place with an active useInput() hook — was
  // unmounted for the entire duration of the agent run, so nothing was
  // listening for keystrokes until now. We put stdin into raw mode ourselves
  // and watch for the raw bytes directly (ESC = 0x1b, Ctrl+C = 0x03), the
  // same technique Ink's own useInput uses internally — raw mode suppresses
  // the tty driver's normal SIGINT-on-Ctrl+C generation on both POSIX and
  // Windows, so byte-level detection is the only reliable cross-platform way
  // to catch Ctrl+C here too.
  const stdin = process.stdin;
  const canListenKeys = manageStdin && stdin.isTTY === true;
  const wasRaw = canListenKeys ? (stdin.isRaw ?? false) : false;

  const onData = (chunk: Buffer | string): void => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // Exact match only — a longer escape sequence (arrow keys, etc. all
    // start with 0x1b) must NOT be misread as a bare Escape press.
    if (str === '\x1b' || str === '\x03') abort();
  };

  // setRawMode can throw in some Windows terminal contexts (e.g. piped
  // stdin masquerading as a TTY, or certain ConEmu/mintty configurations)
  // where POSIX terminals would simply support it — a throw here must not
  // crash the whole agent turn just because Esc-to-cancel can't be wired up.
  if (canListenKeys) {
    try {
      if (!wasRaw) stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on('data', onData);
    } catch {
      /* Esc-to-cancel unavailable this session; SIGINT (Ctrl+C) still works. */
    }
  }

  return {
    signal: controller.signal,
    abort,
    cleanup: () => {
      activeCount--;
      process.removeListener('SIGINT', sigintHandler);
      if (canListenKeys) {
        try {
          stdin.removeListener('data', onData);
          if (!wasRaw) stdin.setRawMode?.(false);
          stdin.pause();
        } catch {
          /* best-effort restore — nothing further to do if this fails */
        }
      }
    },
  };
}
