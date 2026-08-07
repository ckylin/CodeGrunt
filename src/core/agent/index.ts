// ── Agent Module Barrel ───────────────────────────────────────────────────
// Central re-export for the agent subsystem. All public agent APIs are
// accessible from `src/core/agent/index.js` without reaching into internal
// implementation files.
//
// Flow files (coding-flow.ts, chat-flow.ts, skill-flow.ts) are deliberately
// NOT re-exported — they are internal to runAgentLoop and should only be
// called by the orchestrator in loop.ts.

export { runAgentLoop } from './loop.js';
export { detectIntent, selectModelForTask } from './intentor.js';
export { classifyComplexity } from './complexity.js';
export type { ComplexityResult, ComplexityTier } from './complexity.js';
export { generatePlan } from './planner.js';
export { evaluateStep } from './evaluator.js';
export { runSubagent, runSubagentsConcurrent, setSubagentContext } from './subagent.js';
export type { SubagentResult, SubagentRunOptions, ConcurrentSubagentOptions, ConcurrentSubagentResult } from './subagent.js';
export { getSubagentCacheStats, clearSubagentCache } from './subagent-cache.js';
export { MAX_ITERATIONS, MAX_REFINE_RETRIES, UIStreamEmitter, displayToolCalls, runGenerator } from './generator.js';
export type { GeneratorResult } from './generator.js';
