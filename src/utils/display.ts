import chalk from 'chalk';
import type { TaskPlan, EvaluationResult, IntentResult } from '../core/pipeline/types.js';
import { ACCENT } from './constants.js';

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
