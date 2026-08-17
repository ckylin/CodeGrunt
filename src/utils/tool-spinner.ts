// ── Tool Execution Spinner ──────────────────────────────────────────────────
// Decoupled from display.ts so tool stages can import spinner logic without
// pulling in all the CLI display helpers (plan headers, evaluation, etc.).
//
// Used by process-tools.ts in the pipeline stages to show in-progress
// indicators while tool calls are executing.

import chalk from 'chalk';
import { write as chWrite, setLiveTool, hasSink } from '../cli/ink/output-channel.js';

const muted = chalk.gray;
const successColor = chalk.green;
const danger  = chalk.red;

// ── Tool argument extraction ────────────────────────────────────────────

function extractToolKey(args: Record<string, unknown>): { key: string; val: string } {
  const KEY_PRIORITY = ['path', 'command', 'pattern', 'query', 'file_path'];
  const key = KEY_PRIORITY.find(k => k in args) ?? Object.keys(args)[0] ?? '';
  const val = key
    ? (typeof args[key] === 'string' && (args[key] as string).length > 60
        ? (args[key] as string).slice(0, 60) + '…'
        : String(args[key]))
    : '';
  return { key, val };
}

// ── Spinner frames ──────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── Tool output preview ──────────────────────────────────────────────────
// For tools whose real value IS their stdout/stderr (execute_shell — build
// logs, test runs, git diff, ...), the spinner's one-line "✓ ... (234ms)"
// tells the user nothing about what actually happened. The full output is
// already pushed into the LLM's message history, but until now it was never
// shown in the terminal at all — the user had to guess. This prints a capped
// tail preview right after the spinner line. Set CODEGRUNT_HIDE_TOOL_OUTPUT=1
// to fall back to the old silent behavior.
const PREVIEW_MAX_LINES = 15;
const PREVIEW_MAX_LINE_CHARS = 200;

export function printToolOutputPreview(output: string): void {
  if (process.env['CODEGRUNT_HIDE_TOOL_OUTPUT']) return;
  // hasSink() means a persistent App is mounted and process.stdout.isTTY is
  // irrelevant to whether output should show — the App only ever mounts
  // against a real TTY in the first place (see repl.ts's isTTY guard at
  // startup). Fallback mode keeps the original isTTY/env-override gate,
  // which exists for one-shot CLI usage in scripts/CI (no TTY, no App).
  if (!hasSink() && !process.stdout.isTTY && !process.env['CODEGRUNT_FORCE_TOOL_OUTPUT']) return;
  const trimmed = output.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (!trimmed.trim()) return;

  const lines = trimmed.split('\n');
  // Tail, not head — for build/test logs the failure or final result is
  // almost always near the end, and that's what a user glancing over wants.
  const shown = lines.length > PREVIEW_MAX_LINES ? lines.slice(-PREVIEW_MAX_LINES) : lines;
  const hiddenCount = lines.length - shown.length;

  // Built as one block and written via a single write() call rather than
  // one call per line — in sink mode, each write() becomes its own
  // permanent <Static> history entry, so N separate calls would render as
  // N separate entries instead of one cohesive preview block.
  let block = '';
  for (const line of shown) {
    const clipped = line.length > PREVIEW_MAX_LINE_CHARS
      ? line.slice(0, PREVIEW_MAX_LINE_CHARS) + '…'
      : line;
    block += muted('  │ ') + clipped + '\n';
  }
  if (hiddenCount > 0) {
    block += muted(`  │ … ${hiddenCount} more line${hiddenCount > 1 ? 's' : ''} (truncated)`) + '\n';
  }
  chWrite(block);
}

export interface ToolSpinner {
  done(ok: boolean, durationMs: number, errorMsg?: string): void;
}

/**
 * Create an in-progress spinner for a tool call. Writes a single line like
 * "  ⠋ read_file  src/x.ts  3s" and updates the spinner frame + elapsed time
 * in-place using \r until done() is called.
 */
export function createToolSpinner(name: string, args: Record<string, unknown>): ToolSpinner {
  const { val } = extractToolKey(args);
  const startTime = Date.now();

  // Sink mode: a persistent App is mounted, so this spinner drives the
  // App's live-tool-status region via setLiveTool() instead of writing its
  // own \r-based cursor movement — a second thing repositioning the cursor
  // on an 80ms tick would fight Ink's own redraw of that exact region.
  if (hasSink()) {
    let frameIdx = 0;
    setLiveTool({ name, argPreview: val, frame: SPINNER_FRAMES[frameIdx], elapsedMs: 0 });
    const interval = setInterval(() => {
      frameIdx = (frameIdx + 1) % SPINNER_FRAMES.length;
      setLiveTool({ name, argPreview: val, frame: SPINNER_FRAMES[frameIdx], elapsedMs: Date.now() - startTime });
    }, 80);

    return {
      done(ok: boolean, durationMs: number, errorMsg?: string): void {
        clearInterval(interval);
        setLiveTool(null);
        const icon = ok ? successColor('✓') : danger('✗');
        const durationStr = muted(` (${durationMs}ms)`);
        const label = muted(name) + (val ? '  ' + chalk.white(val) : '');
        const line = ok
          ? '  ' + icon + ' ' + label + durationStr + '\n'
          : '  ' + icon + ' ' + label + durationStr + '  ' + danger((errorMsg ?? '').slice(0, 80)) + '\n';
        chWrite(line);
      },
    };
  }

  // Fallback mode — unchanged \r-based in-place spinner for one-shot CLI usage.
  const label = muted(name) + (val ? '  ' + chalk.white(val) : '');
  const isTTY = process.stdout.isTTY;
  let frameIdx = 0;
  let active = true;

  if (isTTY) {
    process.stdout.write('\r  ' + muted(SPINNER_FRAMES[frameIdx]) + ' ' + label);
  }

  const interval = isTTY ? setInterval(() => {
    if (!active) return;
    frameIdx = (frameIdx + 1) % SPINNER_FRAMES.length;
    const f = SPINNER_FRAMES[frameIdx];
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const elapsedStr = elapsed > 0 ? muted(` ${elapsed}s`) : '';
    process.stdout.write('\r  ' + muted(f) + ' ' + label + elapsedStr);
  }, 80) : null;

  return {
    done(ok: boolean, durationMs: number, errorMsg?: string): void {
      active = false;
      if (interval) clearInterval(interval);
      const icon = ok ? successColor('✓') : danger('✗');
      const durationStr = muted(` (${durationMs}ms)`);
      const prefix = isTTY ? '\r' : '';
      if (ok) {
        process.stdout.write(prefix + '  ' + icon + ' ' + label + durationStr + '\n');
      } else {
        const errShort = (errorMsg ?? '').slice(0, 80);
        process.stdout.write(prefix + '  ' + icon + ' ' + label + durationStr + '  ' + danger(errShort) + '\n');
      }
    },
  };
}
