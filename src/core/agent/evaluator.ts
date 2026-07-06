// ── Evaluator Module (P/G/E Architecture) ────────────────────────────────────
// Pure structural evaluation — no LLM call.
//
// Checks:
//   1. Tool errors: any tool result matching known error patterns → fail
//   2. Empty response: no tool calls AND no text output → fail
//   3. Blind write: write/edit without a prior read this session → warning only
//   4. TypeScript typecheck: if write/edit occurred and tsconfig.json exists → run tsc
//
// Rationale: LLM-based evaluation was too expensive (one extra call per step)
// and too inconsistent (same model evaluating its own output). Structural
// checks catch the real failure modes reliably and cheaply.

import type { LLMProvider, Message } from '../../types.js';
import type { PlanStep, EvaluationResult } from '../pipeline/types.js';
import { WRITE_TOOL_NAMES } from '../pipeline/types.js';
import { getLogger } from '../observability/logger.js';
import { getDefaultMetrics } from '../observability/metrics.js';
import { exec } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const log = getLogger('evaluator');

// ── Error patterns for tool result content ────────────────────────────────

const ERROR_PATTERNS = [
  /^Error:/,
  /^Failed/,
  /Command exited with code [1-9]/,
  /Command timed out/,
  /ENOENT/,
  /EACCES/,
  /EPERM/,
  /Permission denied/,
  /Cannot find module/,
  /SyntaxError:/,
  /TypeError:/,
  /is not a function/,
  /undefined is not/,
  /\[no changes\]/,
];

// ── Shell failure classifier ──────────────────────────────────────────────
// Turns a raw shell output string into a targeted suggestion so the model
// doesn't receive a generic "check your parameters" hint.

interface ShellDiagnosis {
  issue: string;
  suggestion: string;
}

function classifyShellFailure(content: string): ShellDiagnosis {
  // Extract the output body (everything after "Output:\n" if present)
  const outputBody = content.includes('\n\nOutput:\n')
    ? content.split('\n\nOutput:\n')[1] ?? content
    : content;

  // Test failures (jest / vitest / mocha / pytest)
  if (/\b(FAIL|FAILED|AssertionError|expect\(|● )/m.test(outputBody)) {
    const failLine = outputBody.split('\n').find(l => /FAIL|●/.test(l)) ?? '';
    return {
      issue: `测试失败: ${failLine.trim().slice(0, 120)}`,
      suggestion: '读取失败的测试文件，分析断言错误原因，修复实现代码后重新运行测试',
    };
  }

  // TypeScript / compilation errors
  if (/error TS\d+/.test(outputBody)) {
    const errLine = outputBody.split('\n').find(l => /error TS/.test(l)) ?? '';
    return {
      issue: `TypeScript 编译错误: ${errLine.trim().slice(0, 120)}`,
      suggestion: '修复 TypeScript 类型错误，使用 read_file 查看相关文件的类型定义',
    };
  }

  // Module not found
  if (/Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/.test(outputBody)) {
    return {
      issue: '模块未找到',
      suggestion: '确认 import 路径是否正确，是否需要安装依赖（npm install）',
    };
  }

  // Permission errors
  if (/EACCES|EPERM|Permission denied/.test(outputBody)) {
    return {
      issue: '权限不足',
      suggestion: '检查文件/目录权限，或尝试使用不需要 sudo 的路径',
    };
  }

  // File not found
  if (/ENOENT|No such file/.test(outputBody)) {
    const pathMatch = outputBody.match(/ENOENT[^']*'([^']+)'/);
    const missingPath = pathMatch?.[1] ?? '';
    return {
      issue: `文件不存在${missingPath ? `: ${missingPath}` : ''}`,
      suggestion: '使用 list_directory 或 search_files 确认路径，再重新执行',
    };
  }

  // Syntax errors
  if (/SyntaxError|ParseError/.test(outputBody)) {
    return {
      issue: 'Syntax 错误',
      suggestion: '检查最近写入的代码中是否有语法错误（括号不匹配、缺少分号等）',
    };
  }

  // Timeout
  if (/Command timed out/.test(content)) {
    return {
      issue: '命令超时',
      suggestion: '命令耗时过长，考虑拆分操作或增加 timeout_ms 参数',
    };
  }

  // Generic non-zero exit
  const exitCodeMatch = content.match(/Command exited with code (\d+)/);
  if (exitCodeMatch) {
    const snippet = outputBody.trim().split('\n').slice(-5).join(' ').slice(0, 200);
    return {
      issue: `命令退出码 ${exitCodeMatch[1]}${snippet ? `，末尾输出: ${snippet}` : ''}`,
      suggestion: '分析上方输出中的错误信息，找到根本原因后修复',
    };
  }

  // Fallback
  const snippet = outputBody.trim().slice(0, 150).replace(/\n/g, ' ');
  return {
    issue: `工具调用失败: ${snippet}`,
    suggestion: '检查工具参数是否正确，文件路径是否存在',
  };
}

// ── TypeScript typecheck helper ───────────────────────────────────────────

function runTsc(cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill();
      resolve({ exitCode: -1, output: '' });
    }, 15000);

    const child = exec(
      'npx tsc --noEmit --skipLibCheck 2>&1',
      { cwd, windowsHide: true },
      (err, stdout) => {
        clearTimeout(timer);
        const exitCode = err?.code ?? 0;
        resolve({ exitCode: typeof exitCode === 'number' ? exitCode : (err ? 1 : 0), output: stdout });
      },
    );
  });
}

// ── Structural checks ─────────────────────────────────────────────────────

function structuralChecks(
  currentTurnToolCalls: Array<{ name: string; args: string }>,
  currentTurnToolResults: Array<{ content: string; toolName?: string }>,
  sessionHasRead: boolean,
  assistantText: string,
): EvaluationResult {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let passed = true;
  let requiresRetry = false;
  let score = 90;

  // Check 1: Tool result errors — diagnose specifically for shell vs other tools
  const errorEntry = currentTurnToolResults.find(tr =>
    ERROR_PATTERNS.some(p => p.test(tr.content))
  );
  if (errorEntry) {
    const isShell = errorEntry.toolName === 'execute_shell'
      || /Command exited|Command timed|ENOENT|EACCES/.test(errorEntry.content);

    if (isShell) {
      const diagnosis = classifyShellFailure(errorEntry.content);
      issues.push(diagnosis.issue);
      suggestions.push(diagnosis.suggestion);
    } else {
      const snippet = errorEntry.content.slice(0, 120).replace(/\n/g, ' ');
      issues.push(`工具调用返回了错误: ${snippet}`);
      suggestions.push('检查工具参数是否正确，文件路径是否存在');
    }
    passed = false;
    requiresRetry = true;
    score -= 40;
  }

  // Check 2: Empty response — real failure, model produced nothing
  if (currentTurnToolCalls.length === 0 && !assistantText?.trim()) {
    issues.push('生成器未执行任何工具调用且无文本输出');
    suggestions.push('请重新执行该步骤');
    passed = false;
    requiresRetry = true;
    score -= 40;
  }

  // Check 3: Blind write — warning only, don't block progress
  const hasWrite = currentTurnToolCalls.some(tc => WRITE_TOOL_NAMES.has(tc.name));
  if (hasWrite && !sessionHasRead) {
    issues.push('写入操作前未读取文件，存在凭空编造代码的风险');
    suggestions.push('建议先用 read_file 了解现有代码再编辑');
    score -= 15;
    // passed stays true — this is a warning, not a blocker
  }

  return {
    passed,
    score: Math.max(0, score),
    issues,
    suggestions,
    requiresRetry,
  };
}

// ── Main Evaluation Function ──────────────────────────────────────────────

export interface EvaluateStepInput {
  planStep: PlanStep;
  messages: Message[];
  assistantText: string;
  /** True if any read_file call has occurred in this session (across all steps) */
  sessionHasRead: boolean;
  /** Tool calls made specifically in this generator turn */
  currentTurnToolCalls: Array<{ name: string; args: string }>;
  /** Tool results from this generator turn */
  currentTurnToolResults: Array<{ content: string; toolName?: string }>;
  language: 'zh' | 'en';
  /** Working directory — used for TypeScript typecheck after write/edit */
  cwd?: string;
  signal?: AbortSignal;
}

/**
 * Evaluate a generation step using structural checks only (no LLM call).
 * Fast, deterministic, and cheap — one evaluation per step.
 */
export async function evaluateStep(
  _provider: LLMProvider,
  _model: string,
  input: EvaluateStepInput,
): Promise<EvaluationResult> {
  const { planStep, assistantText, sessionHasRead, currentTurnToolCalls, currentTurnToolResults, cwd } = input;
  const metrics = getDefaultMetrics();
  const evalTimer = metrics.startTimer('evaluator.duration');

  log.info('Evaluating step (structural)', { stepId: planStep.id, description: planStep.description });

  const result = structuralChecks(currentTurnToolCalls, currentTurnToolResults, sessionHasRead, assistantText);

  // Check 4: TypeScript typecheck — run tsc after write/edit if tsconfig.json exists
  // Skip if structural checks already require a retry (no point typechecking broken output)
  if (!result.requiresRetry && cwd) {
    const hasWriteOrEdit = currentTurnToolCalls.some(tc =>
      tc.name === 'write_file' || tc.name === 'edit_file'
    );
    if (hasWriteOrEdit) {
      const tsconfigPath = path.join(cwd, 'tsconfig.json');
      if (existsSync(tsconfigPath)) {
        try {
          const { exitCode, output } = await runTsc(cwd);
          if (exitCode !== 0 && exitCode !== -1 && output.trim()) {
            const snippet = output.trim().slice(0, 800);
            result.issues.push(`TypeScript errors detected: ${snippet}`);
            result.suggestions.push('Fix the TypeScript errors before continuing');
            result.passed = false;
            result.requiresRetry = true;
            result.score = Math.max(0, result.score - 30);
          }
        } catch {
          // tsc not found or unexpected error — silently skip
        }
      }
    }
  }

  evalTimer();
  metrics.increment('evaluator.calls');
  log.info('Evaluation complete', { passed: result.passed, score: result.score, issues: result.issues.length });

  return result;
}
