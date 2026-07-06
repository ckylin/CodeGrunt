// ── Planner Module (P/G/E Architecture) ────────────────────────────────────
// Analyzes the user's task and produces a structured TaskPlan with
// independently verifiable steps. Uses a separate LLM call (no tools)
// to encourage focused, structured planning.
//
// DeepSeek adaptation:
// - Prompt is highly structured with explicit output format
// - JSON code-block convention (DeepSeek follows this reliably)
// - Max 5 steps to prevent over-planning (DeepSeek struggles with long plans)
// - Fallback to single-step plan on parse failure
//
// Ref: Anthropic Harness P/G/E pattern — Planner stage
// Ref: pipeline/types.ts for TaskPlan, PlanStep interfaces

import type { LLMProvider, Message } from '../../types.js';
import type { TaskPlan, PlanStep } from '../pipeline/types.js';
import { getLogger } from '../observability/logger.js';
import { getDefaultMetrics } from '../observability/metrics.js';
import { getDefaultEventBus, type LLMRequestEvent } from '../events/bus.js';
import { getToolDefinitions } from '../tools/registry.js';

const log = getLogger('planner');

// ── Planner System Prompt (DeepSeek-optimized) ───────────────────────────

function buildPlannerPrompt(language: 'zh' | 'en', task: string, availableTools: string): string {
  const formatInstruction = language === 'zh'
    ? `你是一个任务规划专家。分析用户的任务，将其分解为 2-5 个可独立验证的执行步骤。

## 输出格式（严格遵守）
将你的计划放在一个 JSON 代码块中：

\`\`\`json
{
  "goal": "一句话概括目标",
  "reasoning": "为什么选择这个分解策略（1-2句）",
  "steps": [
    {
      "id": 1,
      "description": "这一步要做什么",
      "toolsHint": ["可能需要用到的工具"],
      "expectedOutcome": "期望的结果",
      "verification": "如何验证这一步是否完成正确"
    }
  ]
}
\`\`\`

## 规划原则
0. **保持简洁。描述用短句，不要写段落。**
1. 每个步骤必须独立可验证——有明确的"完成"标准
2. 读写分离：先读文件了解现状，再编辑/写入
3. 每步最多使用 1-2 个工具（DeepSeek 多工具并行不够稳定）
4. 步骤编号从 1 开始递增
5. 最多 5 个步骤
6. 如果任务很简单（单文件修改），1-2 步即可
7. **"更新多个文件"类任务**：按文件分步（每步读+写一个文件），不要按"分析→执行"分步。分析阶段会消耗大量 token，导致执行阶段上下文不足。
8. **每个写入步骤**必须在同一步内完成读取和写入，不要把读取和写入拆成两步。

## 可用工具
${availableTools}

toolsHint 只能使用上面列出的工具名。

## 用户任务
${task}`
    : `You are a task planning expert. Analyze the user's task and break it into 2-5 independently verifiable execution steps.

## Output Format (follow strictly)
Place your plan in a JSON code block:

\`\`\`json
{
  "goal": "One-sentence goal summary",
  "reasoning": "Why this decomposition strategy (1-2 sentences)",
  "steps": [
    {
      "id": 1,
      "description": "What this step does",
      "toolsHint": ["tools likely needed"],
      "expectedOutcome": "Expected result",
      "verification": "How to verify this step was done correctly"
    }
  ]
}
\`\`\`

## Planning Principles
0. **Be concise. Use short phrases, not paragraphs.**
1. Each step must be independently verifiable — clear "done" criteria
2. Read before write: read files to understand context before editing
3. Max 1-2 tools per step (DeepSeek multi-tool parallelism is unreliable)
4. Steps numbered from 1
5. Max 5 steps
6. Simple tasks (single file edit) can be 1-2 steps
7. **"Update multiple files" tasks**: split by file (each step reads+writes one file). Do NOT split into "analyze then execute" — analysis consumes too many tokens, leaving no context for writing.
8. **Each write step** must include both reading and writing in the same step.

## Available Tools
${availableTools}

toolsHint must only use tool names from the list above.

## User Task
${task}`;

  return formatInstruction;
}

// ── Light model selection ─────────────────────────────────────────────────
// Planning outputs structured JSON — flash is sufficient and much cheaper.
function selectLightModel(configuredModel: string): string {
  if (configuredModel.startsWith('deepseek-')) return 'deepseek-v4-flash';
  return configuredModel;
}

// ── Plan Parsing ─────────────────────────────────────────────────────────

function extractJsonBlock(text: string): string | null {
  // Match ```json ... ``` block
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (match) return match[1].trim();
  // Match raw JSON object
  const objMatch = text.match(/\{[\s\S]*"steps"[\s\S]*\}/);
  if (objMatch) return objMatch[0].trim();
  return null;
}

function parsePlan(raw: string, task: string, validToolNames: Set<string>): TaskPlan {
  const jsonStr = extractJsonBlock(raw);
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr) as TaskPlan;
      // Validate structure
      if (parsed.goal && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
        parsed.steps = parsed.steps.map((s: PlanStep, i: number) => {
          const rawHints = Array.isArray(s.toolsHint) ? s.toolsHint : [];
          const filteredHints = rawHints.filter((t: string) => validToolNames.has(t));
          const removed = rawHints.length - filteredHints.length;
          if (removed > 0) {
            log.warn('Filtered invalid toolsHint entries', { removed, step: i + 1 });
          }
          return {
            id: s.id ?? i + 1,
            description: String(s.description ?? `Step ${i + 1}`),
            toolsHint: filteredHints,
            expectedOutcome: String(s.expectedOutcome ?? 'Complete the step'),
            verification: String(s.verification ?? 'Step completed'),
          };
        });
        parsed.reasoning = parsed.reasoning ?? '';
        log.info('Plan parsed', { steps: parsed.steps.length, goal: parsed.goal });
        return parsed;
      }
    } catch {
      log.warn('Plan JSON parse failed, using fallback');
    }
  }

  // Fallback: single-step plan
  log.warn('Using fallback single-step plan');
  return {
    goal: task.slice(0, 100),
    reasoning: 'Plan parsing failed — executing as single step.',
    steps: [{
      id: 1,
      description: task,
      toolsHint: [],
      expectedOutcome: 'Task completed successfully',
      verification: 'All operations completed without errors',
    }],
  };
}

// ── Plan Generation ──────────────────────────────────────────────────────

/**
 * Generate a TaskPlan by calling the LLM with a planning-specific prompt.
 * Returns a fallback single-step plan if the LLM call or parsing fails.
 */
export async function generatePlan(
  provider: LLMProvider,
  model: string,
  task: string,
  language: 'zh' | 'en',
  signal?: AbortSignal,
): Promise<TaskPlan> {
  const metrics = getDefaultMetrics();
  const bus = getDefaultEventBus();
  const planTimer = metrics.startTimer('planner.duration');

  log.info('Generating plan', { taskLength: task.length, language });

  // Build valid tool names from the registry
  const toolDefs = getToolDefinitions();
  const validToolNames = new Set(toolDefs.map(d => d.function.name));
  const availableTools = Array.from(validToolNames).join(', ');

  const systemPrompt = buildPlannerPrompt(language, task, availableTools);

  const messages: Message[] = [
    { role: 'user', content: systemPrompt },
  ];

  bus.emit({
    type: 'llm:request',
    model: 'planner',
    messageCount: 1,
    estimatedTokens: Math.ceil(systemPrompt.length / 4),
    timestamp: Date.now(),
  } as LLMRequestEvent);

  try {
    let fullText = '';
    const stream = provider.stream(messages, {
      model: selectLightModel(model),
      maxTokens: 1024,
      temperature: 0.1,
      signal,
    });

    for await (const chunk of stream) {
      if (signal?.aborted) break;
      if (chunk.type === 'text_delta') {
        fullText += chunk.text;
      } else if (chunk.type === 'finish') {
        break;
      }
    }

    planTimer();
    metrics.increment('planner.calls');
    return parsePlan(fullText, task, validToolNames);
  } catch (err) {
    planTimer();
    log.error('Plan generation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    metrics.increment('planner.errors');

    // Fallback plan
    return {
      goal: task.slice(0, 100),
      reasoning: 'Plan generation error — executing as single step.',
      steps: [{
        id: 1,
        description: task,
        toolsHint: [],
        expectedOutcome: 'Task completed',
        verification: 'No errors',
      }],
    };
  }
}
