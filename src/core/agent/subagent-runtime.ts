// ── Sub-agent runtime seam ──────────────────────────────────────────────────
// Types and the per-turn context for sub-agents, kept free of imports from the
// tool registry so the `agent_open` tool can depend on this module while
// subagent.ts depends on the registry. subagent.ts registers its runners here
// at load time; without that the tool reports itself unavailable.

import type { LLMProvider } from '../../types.js';

export interface SubagentResult {
  success: boolean;
  output: string;
  toolCallCount: number;
  iterations: number;
  error?: string;
  /** Time elapsed (ms) */
  durationMs?: number;
}

export interface SubagentRunOptions {
  task: string;
  cwd: string;
  provider: LLMProvider;
  model: string;
  /** Replaces the default read-only research-agent system prompt (used by Skills v2 subagent mode). */
  systemOverride?: string;
  signal?: AbortSignal;
  /** Timeout in milliseconds (default: 120000) */
  timeoutMs?: number;
  /** When true, enables result caching by input hash (default: false) */
  useCache?: boolean;
  /** Explicitly disable the automatic flash model downgrade (default: false) */
  noModelDowngrade?: boolean;
  /**
   * Internal: override the tool allowlist, defaults to getSubagentToolNames() (read-only).
   * Not exposed via the agent_open tool schema — only src/core/agent/worker.ts sets this,
   * to grant write_file/edit_file to Orchestrator-dispatched coding sub-tasks.
   */
  _allowedTools?: Set<string>;
}

export interface ConcurrentSubagentOptions {
  tasks: SubagentRunOptions[];
  /** Maximum concurrent sub-agents (default: 10) */
  concurrency?: number;
  /** Global timeout for all sub-agents to complete (default: 120000) */
  timeoutMs?: number;
  /** When true, partial failures are allowed — results contain both successes and failures */
  allowPartialFailure?: boolean;
  /** Signal shared across all sub-agents */
  signal?: AbortSignal;
}

export interface ConcurrentSubagentResult {
  results: SubagentResult[];
  totalTimeMs: number;
  succeeded: number;
  failed: number;
  timedOut: number;
}

// ── Per-turn context ───────────────────────────────────────────────────────
// Tools only receive `args: Record<string, unknown>` — they have no direct
// access to the provider/model configured for the current session. Mirrors
// the setTrustMode() pattern in policy/state.ts.

export interface SubagentContext {
  provider: LLMProvider;
  model: string;
}

let activeContext: SubagentContext | null = null;

export function setSubagentContext(provider: LLMProvider, model: string): void {
  activeContext = { provider, model };
}

export function getSubagentContext(): SubagentContext | null {
  return activeContext;
}

// ── Runner registry ────────────────────────────────────────────────────────

export interface SubagentRunners {
  runSubagent(options: SubagentRunOptions): Promise<SubagentResult>;
  runSubagentsConcurrent(options: ConcurrentSubagentOptions): Promise<ConcurrentSubagentResult>;
}

let runners: SubagentRunners | null = null;

export function registerSubagentRunners(r: SubagentRunners): void {
  runners = r;
}

export function getSubagentRunners(): SubagentRunners | null {
  return runners;
}
