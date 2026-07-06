// ── Language Diagnostics ──────────────────────────────────────────────────
// Runs language-specific checkers after file edits and surfaces errors to the
// agent as structured diagnostic messages.
//
// Supported checkers (auto-detected from project files):
//   TypeScript  — npx tsc --noEmit --skipLibCheck (tsconfig.json present)
//   Python      — npx pyright or python -m pyright (*.py in cwd)
//   Go          — go vet ./... (go.mod present)
//   Rust        — cargo check (Cargo.toml present)
//
// Checkers run with a 20s timeout and only if the relevant project file
// exists in the cwd. Results are returned as structured DiagnosticResult.

import { exec } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../observability/logger.js';

const log = getLogger('lsp:checker');

const CHECKER_TIMEOUT_MS = 20_000;

export interface DiagnosticResult {
  language: string;
  errorCount: number;
  warningCount: number;
  /** Formatted summary for display */
  summary: string;
  /** Raw output truncated to ~600 chars */
  output: string;
  passed: boolean;
}

function runCommand(cmd: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise(resolve => {
    const child = exec(cmd, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      const exitCode = err?.code ?? 0;
      resolve({ exitCode: typeof exitCode === 'number' ? exitCode : (err ? 1 : 0), output });
    });
    setTimeout(() => {
      child.kill();
      resolve({ exitCode: -1, output: '[checker timed out]' });
    }, CHECKER_TIMEOUT_MS);
  });
}

// ── TypeScript ────────────────────────────────────────────────────────────

async function checkTypeScript(cwd: string): Promise<DiagnosticResult | null> {
  if (!existsSync(join(cwd, 'tsconfig.json'))) return null;

  const { exitCode, output } = await runCommand(
    'npx tsc --noEmit --skipLibCheck 2>&1',
    cwd,
  );

  if (exitCode === -1) return null; // timed out, skip

  const errorLines = output.split('\n').filter(l => /error TS\d+/.test(l));
  const warnLines = output.split('\n').filter(l => /warning TS\d+/.test(l));
  const errorCount = errorLines.length;
  const warningCount = warnLines.length;
  const passed = exitCode === 0;

  if (passed && warningCount === 0) return null; // nothing to report

  const snippet = output.trim().slice(0, 600);
  return {
    language: 'TypeScript',
    errorCount,
    warningCount,
    summary: passed
      ? `${warningCount} warning${warningCount !== 1 ? 's' : ''}`
      : `${errorCount} error${errorCount !== 1 ? 's' : ''}${warningCount > 0 ? `, ${warningCount} warning${warningCount !== 1 ? 's' : ''}` : ''}`,
    output: snippet,
    passed,
  };
}

// ── Python ────────────────────────────────────────────────────────────────

async function checkPython(cwd: string): Promise<DiagnosticResult | null> {
  // Only run if there are .py files
  if (!existsSync(join(cwd, 'pyproject.toml')) && !existsSync(join(cwd, 'setup.py')) && !existsSync(join(cwd, 'setup.cfg'))) {
    return null;
  }

  // Try pyright first, fall back to nothing (mypy would work too but isn't universal)
  const { exitCode, output } = await runCommand('npx pyright --outputjson 2>&1', cwd);
  if (exitCode === -1) return null;

  try {
    const json = JSON.parse(output.slice(output.indexOf('{')));
    const summary = json.summary as { errorCount?: number; warningCount?: number; informationCount?: number };
    const errorCount = summary?.errorCount ?? 0;
    const warningCount = summary?.warningCount ?? 0;
    if (errorCount === 0 && warningCount === 0) return null;
    return {
      language: 'Python',
      errorCount,
      warningCount,
      summary: `${errorCount} error${errorCount !== 1 ? 's' : ''}`,
      output: output.slice(0, 600),
      passed: errorCount === 0,
    };
  } catch {
    // pyright not available or non-JSON output
    return null;
  }
}

// ── Go ────────────────────────────────────────────────────────────────────

async function checkGo(cwd: string): Promise<DiagnosticResult | null> {
  if (!existsSync(join(cwd, 'go.mod'))) return null;

  const { exitCode, output } = await runCommand('go vet ./... 2>&1', cwd);
  if (exitCode === -1) return null;
  if (exitCode === 0) return null;

  const errorCount = output.split('\n').filter(l => l.trim()).length;
  return {
    language: 'Go',
    errorCount,
    warningCount: 0,
    summary: `${errorCount} vet issue${errorCount !== 1 ? 's' : ''}`,
    output: output.slice(0, 600),
    passed: false,
  };
}

// ── Rust ──────────────────────────────────────────────────────────────────

async function checkRust(cwd: string): Promise<DiagnosticResult | null> {
  if (!existsSync(join(cwd, 'Cargo.toml'))) return null;

  const { exitCode, output } = await runCommand('cargo check 2>&1', cwd);
  if (exitCode === -1) return null;
  if (exitCode === 0) return null;

  const errorLines = output.split('\n').filter(l => l.startsWith('error'));
  return {
    language: 'Rust',
    errorCount: errorLines.length,
    warningCount: 0,
    summary: `${errorLines.length} error${errorLines.length !== 1 ? 's' : ''}`,
    output: output.slice(0, 600),
    passed: false,
  };
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Run all applicable language checkers for the given cwd.
 * Returns only checkers that found issues (errors or warnings).
 * Fast-fails silently if checkers aren't installed.
 */
export async function runDiagnostics(cwd: string): Promise<DiagnosticResult[]> {
  const results = await Promise.allSettled([
    checkTypeScript(cwd),
    checkPython(cwd),
    checkGo(cwd),
    checkRust(cwd),
  ]);

  const diagnostics: DiagnosticResult[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value !== null) {
      diagnostics.push(r.value);
    } else if (r.status === 'rejected') {
      log.debug('Checker failed', { error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    }
  }
  return diagnostics;
}

/**
 * Format diagnostics as a user-facing message for injection into the agent context.
 */
export function formatDiagnostics(diagnostics: DiagnosticResult[], lang: 'zh' | 'en'): string {
  if (diagnostics.length === 0) return '';

  const header = lang === 'zh'
    ? '⚠️ 代码诊断结果（编辑后自动检查）'
    : '⚠️ Post-edit diagnostics';

  const items = diagnostics.map(d => {
    const status = d.passed ? '⚠️' : '❌';
    return `${status} ${d.language}: ${d.summary}\n\`\`\`\n${d.output}\n\`\`\``;
  });

  const footer = lang === 'zh'
    ? '请修复上述问题后继续。'
    : 'Please fix these issues before continuing.';

  return `${header}\n\n${items.join('\n\n')}\n\n${footer}`;
}
