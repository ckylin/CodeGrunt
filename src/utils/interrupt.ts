export interface InterruptController {
  signal: AbortSignal;
  cleanup: () => void;
}

// Track active interrupt controllers so the global SIGINT handler in repl.ts
// can distinguish between "abort current task" and "exit the REPL entirely".
let activeCount = 0;
export function getActiveInterruptCount(): number {
  return activeCount;
}

export function createInterruptController(): InterruptController {
  const controller = new AbortController();

  activeCount++;

  const abort = (): void => {
    if (controller.signal.aborted) return;
    process.stdout.write('\n');
    controller.abort();
  };

  const sigintHandler = (): void => abort();
  process.on('SIGINT', sigintHandler);

  // ── Escape-to-cancel ────────────────────────────────────────────────────
  // The "Thinking... (Esc to cancel)" hint shown during generation (see
  // UIStreamEmitter in generator.ts) needs a real key listener. Ink's
  // PromptInput — the only place with an active useInput() hook — is
  // unmounted for the entire duration of the agent run, so nothing is
  // listening for keystrokes until now. We put stdin into raw mode ourselves
  // and watch for the raw bytes directly (ESC = 0x1b, Ctrl+C = 0x03), the
  // same technique Ink's own useInput uses internally — raw mode suppresses
  // the tty driver's normal SIGINT-on-Ctrl+C generation on both POSIX and
  // Windows, so byte-level detection is the only reliable cross-platform way
  // to catch Ctrl+C here too.
  const stdin = process.stdin;
  const canListenKeys = stdin.isTTY === true;
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
