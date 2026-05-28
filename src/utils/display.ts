import chalk from 'chalk';
import type { TaskPlan, EvaluationResult, IntentResult } from '../core/pipeline/types.js';
import { ACCENT } from './constants.js';

const blue  = (s: string) => chalk.hex(ACCENT)(s);
const muted = chalk.gray;
const successColor = chalk.green;
const danger  = chalk.red;
const warning = chalk.yellow;

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

// ── Tool execution spinner ──────────────────────────────────────────────

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

export function printUserMessage(text: string): void {
  process.stdout.write('\n  ' + blue('You') + '\n');
  for (const line of text.split('\n')) {
    process.stdout.write('  ' + chalk.white(line) + '\n');
  }
  process.stdout.write('\n');
}

export function printAssistantHeader(): void {
  // Silent by default — the separator line is visual noise.
  // Enable CODEGRUNT_VERBOSE to see the header.
  if (!process.env['CODEGRUNT_VERBOSE']) return;
  const cols = process.stdout.columns || 80;
  const label = ' ' + blue('CodeGrunt') + ' ';
  const labelLen = ' CodeGrunt '.length;
  const fill = Math.max(0, cols - labelLen - 2);
  const half = Math.floor(fill / 2);
  process.stdout.write(
    '\n' + muted('-'.repeat(half)) + label + muted('-'.repeat(fill - half)) + '\n\n'
  );
}

export function printThinkingCollapsed(reasoningText: string, elapsedMs: number): void {
  const secs = Math.round(elapsedMs / 1000);
  process.stdout.write(muted(`  thought for ${secs}s\n\n`));
}

export function printError(message: string): void {
  process.stderr.write(danger('  error  ') + message + '\n');
}

export function printInfo(message: string): void {
  process.stdout.write(muted('  ' + message) + '\n');
}

export function printDivider(): void {
  process.stdout.write(muted('-'.repeat(process.stdout.columns || 80)) + '\n');
}

// ── P/G/E Plan & Evaluation Display ─────────────────────────────────────
// All plan/step/eval display functions are silent by default to match the
// Claude Code experience. Enable CODEGRUNT_VERBOSE to see them.

/** Display intent classification result — silent by default */
export function printIntentResult(intent: IntentResult): void {
  if (!process.env['CODEGRUNT_VERBOSE']) return;
  if (intent.matchedSkill) {
    process.stdout.write(muted(`  skill: ${intent.matchedSkill.name}\n`));
  } else if (!intent.isCoding) {
    process.stdout.write(muted('  chat mode\n'));
  }
}

/** Display the plan header when Planner completes — silent by default */
export function printPlanHeader(plan: TaskPlan): void {
  if (!process.env['CODEGRUNT_VERBOSE']) return;
  const stepCount = plan.steps.length;
  process.stdout.write('\n  ' + blue('▸') + '  ' + chalk.bold(plan.goal) + muted(`  (${stepCount} steps)`) + '\n');
}

/** Display current step progress — silent by default */
export function printStepProgress(stepIndex: number, totalSteps: number, description: string): void {
  if (!process.env['CODEGRUNT_VERBOSE']) return;
  const truncated = description.length > 60 ? description.slice(0, 60) + '…' : description;
  process.stdout.write('\n' + muted(`  ${stepIndex + 1}/${totalSteps}  `) + truncated + '\n');
}

/** Display evaluation result — silent unless DEBUG or CODEGRUNT_VERBOSE */
export function printEvaluation(evaluation: EvaluationResult, _language: 'zh' | 'en'): void {
  if (evaluation.passed) return;
  if (!process.env['DEBUG'] && !process.env['CODEGRUNT_VERBOSE']) return;
  const scoreColor = evaluation.score >= 60 ? warning : danger;
  process.stdout.write('  ' + danger('✗') + '  ' + scoreColor(`${evaluation.score}/100`) + '\n');
  for (const issue of evaluation.issues.slice(0, 2)) {
    process.stdout.write('  ' + muted('  ') + danger(String(issue).slice(0, 100)) + '\n');
  }
}

/** Display refinement retry indicator — silent by default */
export function printRefineIndicator(retryCount: number, maxRetries: number, _language: 'zh' | 'en'): void {
  if (!process.env['CODEGRUNT_VERBOSE']) return;
  process.stdout.write(muted(`  retrying ${retryCount}/${maxRetries}…\n`));
}
