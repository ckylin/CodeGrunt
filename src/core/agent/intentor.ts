// ── Intentor Module (P/G/E Architecture) ────────────────────────────────────
// Phase 0 of the agent loop. Classifies user intent as coding vs non-coding
// to route to the appropriate execution path:
//
//   Coding:     Intentor → Planner → Generator → Evaluator → (retry)
//   Non-coding: Intentor → (lightweight Planner) → Generator
//
// Strategy: fast heuristic first (no LLM cost), LLM fallback only when
// confidence is low. This keeps latency near-zero for clear cases.
//
// Ref: pipeline/types.ts for IntentResult

import chalk from 'chalk';
import type { LLMProvider, Message } from '../../types.js';
import type { IntentResult } from '../pipeline/types.js';
import type { Skill } from '../../cli/skills.js';
import { getLogger } from '../observability/logger.js';
import { getDefaultMetrics } from '../observability/metrics.js';

const log = getLogger('intentor');

// ── Heuristic classification ─────────────────────────────────────────────

// Strong coding signals — high confidence without LLM
const CODING_PATTERNS = [
  /\b(写|创建|实现|修改|重构|添加|删除|修复|优化|重写)\s*(一个|这个|该)?\s*(函数|方法|类|组件|模块|接口|类型|文件|代码|脚本|测试|API|路由|中间件|hook|store)/i,
  /\b(write|create|implement|modify|refactor|add|remove|delete|fix|optimize|rewrite)\s+(a\s+)?(function|method|class|component|module|interface|type|file|code|script|test|api|route|middleware|hook|store)/i,
  /\b(bug|error|exception|crash|fail|broken|doesn'?t work|not working)\b/i,
  /\b(import|export|require|const|let|var|function|class|interface|type|enum)\b/,
  /\.(ts|tsx|js|jsx|py|go|rs|java|cs|cpp|c|rb|php|swift|kt)\b/,
  /\b(npm|yarn|pnpm|pip|cargo|go get|mvn)\b/i,
  /\b(git|commit|branch|merge|rebase|pull request|PR)\b/i,
  /\b(test|spec|unit test|integration test|e2e|vitest|jest|pytest)\b/i,
  /\b(database|sql|query|migration|schema|model|orm)\b/i,
  /\b(deploy|build|compile|lint|typecheck|ci\/cd|docker|kubernetes)\b/i,
  /```[\s\S]*?```/,  // code block in message
  /`[^`]+`/,         // inline code
];

// Strong non-coding signals
const NON_CODING_PATTERNS = [
  /^(what|how|why|when|where|who|which|explain|describe|tell me|can you|could you|please)\b/i,
  /\b(explain|describe|summarize|translate|write an? (email|letter|essay|article|report|document|summary|plan|proposal))\b/i,
  /\b(what is|what are|what does|how does|why does|when should|where is)\b/i,
  /\b(pros and cons|compare|difference between|vs\.?|versus)\b/i,
  /\b(help me understand|i don'?t understand|confused about)\b/i,
];

function heuristicClassify(task: string): IntentResult | null {
  const text = task.trim();

  let codingScore = 0;
  let nonCodingScore = 0;

  for (const pattern of CODING_PATTERNS) {
    if (pattern.test(text)) codingScore++;
  }
  for (const pattern of NON_CODING_PATTERNS) {
    if (pattern.test(text)) nonCodingScore++;
  }

  // Clear coding signal
  if (codingScore >= 2 && codingScore > nonCodingScore) {
    return {
      isCoding: true,
      confidence: Math.min(95, 60 + codingScore * 10),
      reason: 'coding keywords detected',
      needsFullPlan: true,
    };
  }

  // Clear non-coding signal
  if (nonCodingScore >= 2 && nonCodingScore > codingScore) {
    return {
      isCoding: false,
      confidence: Math.min(90, 55 + nonCodingScore * 10),
      reason: 'conversational/explanatory intent',
      needsFullPlan: false,
    };
  }

  // Single weak signal — low confidence, needs LLM
  if (codingScore === 1 && nonCodingScore === 0) {
    return {
      isCoding: true,
      confidence: 55,
      reason: 'weak coding signal',
      needsFullPlan: true,
    };
  }

  return null; // Ambiguous — defer to LLM
}

// ── Skill matching ───────────────────────────────────────────────────────

/** Build a set of keyword tokens from a skill's name and description. */
function skillTokens(skill: Skill): string[] {
  const raw = `${skill.name} ${skill.description ?? ''}`.toLowerCase();
  return raw.split(/[\s\-_,;/]+/).filter((t) => t.length > 2);
}

/**
 * Try to match the task against loaded skills using keyword overlap.
 * Returns the best-matching skill if confidence is high enough, else null.
 */
function matchSkillHeuristic(task: string, skills: Skill[]): Skill | null {
  if (skills.length === 0) return null;

  const taskLower = task.toLowerCase();
  let bestSkill: Skill | null = null;
  let bestScore = 0;

  for (const skill of skills) {
    const tokens = skillTokens(skill);
    if (tokens.length === 0) continue;

    const hits = tokens.filter((t) => taskLower.includes(t)).length;
    const score = hits / tokens.length;

    if (score > bestScore) {
      bestScore = score;
      bestSkill = skill;
    }
  }

  // Require at least 40% token overlap to avoid false positives
  return bestScore >= 0.4 ? bestSkill : null;
}

// ── LLM-based classification ─────────────────────────────────────────────

function buildIntentorPrompt(language: 'zh' | 'en', task: string, skills: Skill[]): string {
  const skillsSection = skills.length > 0
    ? (language === 'zh'
        ? `\n## 可用 Skills\n如果用户请求明确匹配某个 skill，在 JSON 中返回 "matchedSkill": "<skill-name>"。\n${skills.map((s) => `- ${s.name}: ${s.description ?? '(no description)'}`).join('\n')}\n`
        : `\n## Available Skills\nIf the request clearly matches a skill, return "matchedSkill": "<skill-name>" in the JSON.\n${skills.map((s) => `- ${s.name}: ${s.description ?? '(no description)'}`).join('\n')}\n`)
    : '';

  if (language === 'zh') {
    return `你是一个意图分类器。判断用户的请求是否属于"编程/代码"类任务。

## 编程类任务包括
- 写代码、修改代码、重构代码
- 修复 bug、调试、优化性能
- 创建/修改文件、配置、脚本
- 运行命令、构建、测试、部署
- 解释具体代码片段（需要读取文件）

## 非编程类任务包括
- 解释概念、回答问题
- 写文章、邮件、文档（不涉及代码文件）
- 翻译、总结、分析文本
- 闲聊、建议、规划
${skillsSection}
## 用户请求
${task.slice(0, 500)}

## 输出格式（严格遵守）
\`\`\`json
{"isCoding": true, "confidence": 85, "reason": "简短原因", "matchedSkill": null}
\`\`\``;
  }

  return `You are an intent classifier. Determine whether the user's request is a "coding/programming" task.

## Coding tasks include
- Writing, modifying, or refactoring code
- Fixing bugs, debugging, optimizing performance
- Creating/modifying files, configs, scripts
- Running commands, building, testing, deploying
- Explaining specific code snippets (requires reading files)

## Non-coding tasks include
- Explaining concepts, answering questions
- Writing articles, emails, docs (no code files involved)
- Translating, summarizing, analyzing text
- Casual conversation, advice, planning
${skillsSection}
## User request
${task.slice(0, 500)}

## Output format (follow strictly)
\`\`\`json
{"isCoding": true, "confidence": 85, "reason": "brief reason", "matchedSkill": null}
\`\`\``;
}

function parseIntentResult(raw: string, fallback: boolean, skills: Skill[]): IntentResult {
  const match = raw.match(/```json\s*([\s\S]*?)\s*```/) ?? raw.match(/\{[\s\S]*?"isCoding"[\s\S]*?\}/);
  const jsonStr = match ? (match[1] ?? match[0]) : null;

  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr.trim()) as {
        isCoding: boolean;
        confidence: number;
        reason: string;
        matchedSkill?: string | null;
      };

      let matchedSkill: IntentResult['matchedSkill'];
      if (parsed.matchedSkill) {
        const skill = skills.find((s) => s.name.toLowerCase() === parsed.matchedSkill!.toLowerCase());
        if (skill) {
          matchedSkill = { name: skill.name, content: skill.content, system: skill.system };
        }
      }

      return {
        isCoding: Boolean(parsed.isCoding),
        confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 70)),
        reason: String(parsed.reason ?? ''),
        needsFullPlan: Boolean(parsed.isCoding),
        matchedSkill,
      };
    } catch { /* fall through */ }
  }

  return {
    isCoding: fallback,
    confidence: 50,
    reason: 'classification uncertain',
    needsFullPlan: fallback,
  };
}

// ── Spinner helpers ──────────────────────────────────────────────────────

function startSpinner(text: string): ReturnType<typeof setInterval> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let idx = 0;
  const interval = setInterval(() => {
    process.stdout.write('\r' + chalk.gray(`${frames[idx]} ${text}`));
    idx = (idx + 1) % frames.length;
  }, 80);
  return interval;
}

function stopSpinner(interval: ReturnType<typeof setInterval>): void {
  clearInterval(interval);
  process.stdout.write('\r' + ' '.repeat(40) + '\r');
}

// ── Main export ──────────────────────────────────────────────────────────

/**
 * Classify user intent. Uses fast heuristics first; falls back to a
 * lightweight LLM call only when the heuristic is ambiguous.
 * If skills are provided, also attempts to match the task to a skill.
 */
export async function detectIntent(
  provider: LLMProvider,
  model: string,
  task: string,
  language: 'zh' | 'en',
  signal?: AbortSignal,
  skills: Skill[] = [],
): Promise<IntentResult> {
  const metrics = getDefaultMetrics();
  const timer = metrics.startTimer('intentor.duration');

  // Fast path: skill heuristic match
  const skillMatch = matchSkillHeuristic(task, skills);
  if (skillMatch) {
    timer();
    log.info('Intent matched to skill by heuristic', { skill: skillMatch.name });
    metrics.increment('intentor.skill_hits');
    return {
      isCoding: false,
      confidence: 85,
      reason: `matched skill: ${skillMatch.name}`,
      needsFullPlan: false,
      matchedSkill: { name: skillMatch.name, content: skillMatch.content, system: skillMatch.system },
    };
  }

  // Fast path: coding/non-coding heuristic
  const heuristic = heuristicClassify(task);
  if (heuristic && heuristic.confidence >= 70) {
    timer();
    log.info('Intent classified by heuristic', { isCoding: heuristic.isCoding, confidence: heuristic.confidence });
    metrics.increment('intentor.heuristic_hits');
    return heuristic;
  }

  // Slow path: LLM (includes skill list in prompt when available)
  log.info('Heuristic ambiguous, using LLM for intent classification', {
    heuristicConfidence: heuristic?.confidence ?? 0,
  });

  const prompt = buildIntentorPrompt(language, task, skills);
  const messages: Message[] = [{ role: 'user', content: prompt }];

  const spinner = startSpinner('Classifying intent…');

  try {
    let fullText = '';
    const stream = provider.stream(messages, {
      model,
      maxTokens: 256,
      temperature: 0.0,
      signal,
    });

    for await (const chunk of stream) {
      if (signal?.aborted) break;
      if (chunk.type === 'text_delta') fullText += chunk.text;
      else if (chunk.type === 'finish') break;
    }

    stopSpinner(spinner);
    timer();
    metrics.increment('intentor.llm_calls');
    const result = parseIntentResult(fullText, heuristic?.isCoding ?? true, skills);
    log.info('Intent classified by LLM', { isCoding: result.isCoding, confidence: result.confidence, matchedSkill: result.matchedSkill?.name });
    return result;
  } catch (err) {
    stopSpinner(spinner);
    timer();
    log.warn('Intent LLM call failed, defaulting to coding=true', {
      error: err instanceof Error ? err.message : String(err),
    });
    metrics.increment('intentor.errors');
    return heuristic ?? {
      isCoding: true,
      confidence: 50,
      reason: 'classification failed — defaulting to coding path',
      needsFullPlan: true,
    };
  }
}
