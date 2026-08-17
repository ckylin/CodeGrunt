import chalk from 'chalk';
import type { TaskPlan, EvaluationResult, IntentResult } from '../core/pipeline/types.js';
import { ACCENT } from './constants.js';
import { formatErrorForDisplay } from '../core/errors.js';

const blue  = (s: string) => chalk.hex(ACCENT)(s);
const muted = chalk.gray;
const danger  = chalk.red;
const warning = chalk.yellow;

// ── Tool spinner re-export ──────────────────────────────────────────────
// ToolSpinner lives in tool-spinner.ts so pipeline stages don't need to pull
// in all the P/G/E display helpers just to get a spinner.
export { createToolSpinner, type ToolSpinner } from './tool-spinner.js';

// ── CLI Display Helpers ─────────────────────────────────────────────────

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

/** Like printError, but branches the label on the error's type (network / api /
 *  config / tool / timeout / cancelled) via formatErrorForDisplay() instead of
 *  always showing the generic "error" label — lets the user tell "DeepSeek is
 *  down" apart from "your API key is wrong" apart from "you hit Esc" at a glance. */
export function printTypedError(err: unknown): void {
  const { label, message } = formatErrorForDisplay(err);
  process.stderr.write(danger(`  ${label}  `) + message + '\n');
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

// ── /plan Tree Visualization (v0.8) ──────────────────────────────────────
// Status per step, mirroring how coding-flow.ts drives the retry loop:
//   'pending'     — not started yet
//   'in_progress' — currently running (including refine retries)
//   'done'        — evaluator passed (or user chose to continue past failure)
//   'failed'      — max retries exhausted and user rejected continuing
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'failed';

// Matches the ✓/✗ glyphs used by the tool-execution spinner (tool-spinner.ts)
// so "done"/"failed" reads as the same concept everywhere in the UI.
const STEP_ICONS: Record<PlanStepStatus, string> = {
  pending: ' ',
  in_progress: '→',
  done: '✓',
  failed: '✗',
};

function stepIconColor(status: PlanStepStatus, icon: string): string {
  switch (status) {
    case 'done': return chalk.green(icon);
    case 'failed': return danger(icon);
    case 'in_progress': return blue(icon);
    default: return muted(icon);
  }
}

/**
 * Render a TaskPlan as an ASCII tree with per-step status icons.
 * Pure function (no I/O) so it can be unit tested directly; printPlanTree()
 * below is the side-effecting wrapper gated by CODEGRUNT_VERBOSE.
 */
export function renderPlanTree(plan: TaskPlan, stepStatuses: PlanStepStatus[]): string {
  const lines: string[] = [];
  lines.push(blue('▸') + '  ' + chalk.bold(plan.goal) + muted(`  (${plan.steps.length} steps)`));

  plan.steps.forEach((step, i) => {
    const status = stepStatuses[i] ?? 'pending';
    const isLast = i === plan.steps.length - 1;
    const branch = isLast ? '└─' : '├─';
    const icon = stepIconColor(status, STEP_ICONS[status]);
    const desc = status === 'failed' ? danger(step.description) : step.description;
    lines.push(`  ${muted(branch)} ${icon} ${desc}`);
  });

  return lines.join('\n');
}

/** Print the plan tree (with live step statuses) — silent by default */
export function printPlanTree(plan: TaskPlan, stepStatuses: PlanStepStatus[]): void {
  if (!process.env['CODEGRUNT_VERBOSE']) return;
  process.stdout.write('\n' + renderPlanTree(plan, stepStatuses) + '\n');
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
