// ── Tool Execution Spinner ──────────────────────────────────────────────────
// Decoupled from display.ts so tool stages can import spinner logic without
// pulling in all the CLI display helpers (plan headers, evaluation, etc.).
//
// Used by process-tools.ts in the pipeline stages to show in-progress
// indicators while tool calls are executing.

import chalk from 'chalk';

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
  const label = muted(name) + (val ? '  ' + chalk.white(val) : '');
  const isTTY = process.stdout.isTTY;
  const startTime = Date.now();
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
