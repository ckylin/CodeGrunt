// ── Output Channel Abstraction ───────────────────────────────────────────────
// The root cause of "the input box has to unmount while the agent runs" is
// that raw process.stdout.write() calls scattered across the agent core
// (loop.ts, chat-flow.ts, coding-flow.ts, skill-flow.ts, intentor.ts,
// tool-spinner.ts, ...) fight with Ink's own redraw cycle — Ink repaints its
// "live" region using ANSI cursor movement, and any stdout write that lands
// outside that mechanism corrupts the frame. The old design avoided this by
// never having both active at once: PromptInput unmounts entirely before the
// agent runs, and remounts fresh after.
//
// This module is the seam that removes that constraint. Callers that used to
// call `process.stdout.write(...)` directly now call `write()`/
// `appendLiveText()`/`setLiveTool()` here instead. Two modes:
//
//   - No sink registered (one-shot `codegrunt "<task>"` mode, which never
//     mounts a persistent Ink tree) — every call falls straight through to
//     process.stdout.write with IDENTICAL behavior to before this module
//     existed. One-shot mode's output is byte-for-byte unchanged.
//   - A sink registered (interactive REPL mode, via the persistent <App>
//     component) — output is routed into React state instead, so Ink's
//     reconciler owns the redraw and a live PromptInput can coexist with
//     streaming agent output.
//
// Deliberately NOT an EventEmitter/pub-sub with multiple subscribers: there
// is exactly one place output can go at a time (stdout, or the one mounted
// App), so a single optional sink slot is simpler and makes "no sink
// registered" trivially detectable.

export interface LiveToolInfo {
  /** Tool name, e.g. "execute_shell". */
  name: string;
  /** Short preview of the tool's key argument (path/command/query/...). */
  argPreview: string;
  /** Current spinner frame character. */
  frame: string;
  elapsedMs: number;
}

export interface OutputChannelSink {
  /** A fully-formed, completed block of output — appended as a permanent
   *  history entry (rendered inside <Static> by the App). */
  writeLine(text: string): void;
  /** Replaces the current streaming text for the in-progress turn. Called
   *  with the FULL accumulated text so far (not a delta) so the sink can
   *  just re-render its buffer without tracking state itself. */
  setLiveText(text: string): void;
  /** Current tool-call status, or null to clear it. */
  setLiveTool(info: LiveToolInfo | null): void;
}

let sink: OutputChannelSink | null = null;
let liveTextBuffer = '';

/** Called once by the persistent <App> component on mount. */
export function registerSink(s: OutputChannelSink): void {
  sink = s;
}

/** Called on <App> unmount (session end) — restores raw-stdout fallback mode. */
export function unregisterSink(): void {
  sink = null;
  liveTextBuffer = '';
}

export function hasSink(): boolean {
  return sink !== null;
}

/** Writes a complete, self-contained block of output (typically already
 *  ending in '\n', matching how the migrated call sites previously called
 *  process.stdout.write directly). */
export function write(text: string): void {
  if (sink) {
    sink.writeLine(text);
  } else {
    process.stdout.write(text);
  }
}

/**
 * Appends a streaming text delta for the turn currently in progress.
 * In fallback mode this writes the delta directly to stdout — identical to
 * the pre-existing UIStreamEmitter behavior. In sink mode it accumulates
 * into a buffer and pushes the FULL buffer to the sink, since Ink re-renders
 * the whole live region from scratch each time rather than appending.
 */
export function appendLiveText(delta: string): void {
  if (sink) {
    liveTextBuffer += delta;
    sink.setLiveText(liveTextBuffer);
  } else {
    process.stdout.write(delta);
  }
}

/**
 * Finalizes the current live text buffer into a permanent history entry
 * (sink mode only — fallback mode's content is already on stdout, nothing
 * further to do). Must be called when a turn's streaming finishes, whether
 * it ended normally or was aborted, or the next turn's live text would
 * visually concatenate with an uncommitted leftover from this one.
 */
export function commitLiveText(): void {
  if (sink && liveTextBuffer) {
    sink.writeLine(liveTextBuffer);
  }
  liveTextBuffer = '';
  if (sink) sink.setLiveText('');
}

/** Discards the current live text buffer without committing it (e.g. on
 *  abort, where partial streamed text should not become a permanent entry —
 *  matches how aborted one-shot output already just stops mid-stream). */
export function discardLiveText(): void {
  liveTextBuffer = '';
  if (sink) sink.setLiveText('');
}

export function setLiveTool(info: LiveToolInfo | null): void {
  if (sink) sink.setLiveTool(info);
  // Fallback mode: tool-spinner.ts keeps its own \r-based rendering path
  // for one-shot mode — this function is a no-op there, not a passthrough,
  // since the fallback spinner writes directly to stdout itself.
}
