// ── Harness-style Pipeline Architecture ────────────────────────────────────
// Pattern reference: Harness CI/CD pipeline engine
// Each stage is an independent, testable unit that receives a shared context
// and can modify it. Stages are composed into a Pipeline which is executed
// by the PipelineEngine.
//
// Extended with Planner / Generator / Evaluator (P/G/E) pattern for
// DeepSeek quality assurance — planner produces structured task plans,
// generator executes them, evaluator verifies output quality.

import type { Message, ToolCall, ToolResult, ToolDefinition, LLMProvider, CodeGruntConfig } from '../../types.js';

// ── P/G/E Types ──────────────────────────────────────────────────────────

/** Intent classification result from the Intentor */
export interface IntentResult {
  /** Whether the task involves writing/modifying code or files */
  isCoding: boolean;
  /** Confidence score 0-100 */
  confidence: number;
  /** Brief reason for the classification */
  reason: string;
  /** Matched skill, if the intent maps to a loaded skill */
  matchedSkill?: { name: string; content: string; system?: string; mode?: 'inline' | 'subagent' };
}

/** A single step in an execution plan */
export interface PlanStep {
  /** Step index (1-based) */
  id: number;
  /** Human-readable description of what this step should do */
  description: string;
  /** Tools likely to be needed (hint for the generator) */
  toolsHint: string[];
  /** What the step should produce or achieve */
  expectedOutcome: string;
  /** How to verify this step was done correctly */
  verification: string;
}

/** A structured task execution plan */
export interface TaskPlan {
  /** Overall goal summary */
  goal: string;
  /** Ordered execution steps (max 5, each independently verifiable) */
  steps: PlanStep[];
  /** Planner's rationale for this plan structure */
  reasoning: string;
}

/** Result of evaluating a generation step */
export interface EvaluationResult {
  /** Whether the step passed quality checks */
  passed: boolean;
  /** Score 0-100 — quality rating */
  score: number;
  /** Specific issues found */
  issues: string[];
  /** Suggestions for fixing issues */
  suggestions: string[];
  /** Whether this step should be retried with refinements */
  requiresRetry: boolean;
}

// ── Pipeline Context (shared state across stages) ────────────────────────

export interface PipelineContext {
  /** Working directory */
  cwd: string;
  /** Runtime configuration */
  config: CodeGruntConfig;
  /** LLM provider instance */
  provider: LLMProvider;
  /** Conversation messages (managed by ContextManager) */
  messages: Message[];
  /** System prompt (built once, reused across iterations) */
  systemPrompt: string;
  /** Whether the model is a reasoner (R1) variant */
  isReasoner: boolean;
  /** V4 thinking mode: 'enabled' | 'disabled' — set by complexity router */
  thinking?: 'enabled' | 'disabled';
  /** User's task / input for this turn */
  task: string;
  /** Tool definitions to expose to the model */
  toolDefinitions: ToolDefinition[];
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Maximum iterations */
  maxIterations: number;
  /** Current iteration counter */
  iteration: number;
  /** Accumulated reasoning text for this turn */
  reasoningText: string;
  /** Accumulated assistant text for this turn */
  assistantText: string;
  /** Tool calls extracted from the response */
  toolCalls: ToolCall[];
  /** Finish reason from the model */
  finishReason: 'stop' | 'tool_calls' | 'length' | null;
  /** Token usage for this turn */
  outputTokens: number;
  /** Whether any read tool was called this turn */
  hasReadThisTurn: boolean;
  /** Whether blind-write warning was already issued this turn */
  warnedBlindWrite: boolean;
  /** Language for system prompt generation */
  language: 'zh' | 'en';
  /** When set, replaces the default coding-assistant system prompt (used by skills). */
  systemPromptOverride?: string;
  /** Session summary from previous compact — injected into system prompt on first turn. */
  memorySummary?: string;
  /** Formatted user habit preferences — injected into system prompt above session summary. */
  userPreferences?: string;
  // ── P/G/E fields ────────────────────────────────────────────────────
  /** The current execution plan (set by Planner) */
  plan?: TaskPlan;
  /** Current plan step index (0-based) */
  planStepIndex?: number;
  /** Latest evaluation result (set by Evaluator) */
  lastEvaluation?: EvaluationResult;
  /** Number of refinement retries for the current step */
  refineCount?: number;
}

// ── Stage Interface ──────────────────────────────────────────────────────

export interface StageResult {
  /** Whether to continue to the next stage */
  continue: boolean;
  /** If true, stop the entire pipeline (terminal result) */
  done: boolean;
  /** User rejected an operation — halt immediately */
  userRejected?: boolean;
}

export interface Stage {
  /** Unique stage name for logging/observability */
  readonly name: string;
  /** Execute this stage */
  execute(ctx: PipelineContext): Promise<StageResult>;
}

// ── Pipeline Interface ───────────────────────────────────────────────────

export interface Pipeline {
  readonly name: string;
  /** Ordered list of stages */
  readonly stages: Stage[];
}

export interface PipelineResult {
  done: boolean;
  userRejected: boolean;
  error?: Error;
}

// ── Streaming emitter (decouples LLM streaming from display) ─────────────

export interface StreamEmitter {
  /** Called once before streaming begins, to show a waiting indicator */
  startThinking?(): void;
  onTextDelta(text: string): void;
  onReasoningDelta(text: string): void;
  onToolCallDelta(index: number, id?: string, name?: string, argsDelta?: string): void;
  onFinish(reason: 'stop' | 'tool_calls' | 'length'): void;
}

// ── Anti-hallucination config ────────────────────────────────────────────

export const READ_TOOL_NAMES = new Set(['read_file', 'search_files', 'list_directory']);
export const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file']);
