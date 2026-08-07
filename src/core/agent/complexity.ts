// ── Request Classifier ──────────────────────────────────────────────────────
// Determines whether a user request is a "code writing/production" task
// (requiring the full P/G/E pipeline) versus a conversational or
// informational query that can be answered directly.
//
// This is used by the direct-response module to short-circuit non-code
// requests before entering the agent loop / planner stages.

// ── Code-request keywords ─────────────────────────────────────────────────
// Each entry is [regex pattern, weight] — matched case-insensitively against
// the full input. Order matters for multi-word patterns (longer first).
const CODE_PATTERNS: Array<[RegExp, number]> = [
  // ── Strong multi-word indicators ──────────────────────────────────────
  [/\bwrite\b.+\b(function|class|script|program|code|test|file|module|api|component|endpoint)\b/i, 5],
  [/\bcreate\b.+\b(function|class|script|program|code|test|file|module|api|component|endpoint)\b/i, 5],
  [/\bimplement\b.+\b(function|class|module|api|feature)\b/i, 5],
  [/\b(build|make)\b.+\b(app|component|module|api|endpoint|website|server|cli)\b/i, 4],
  [/\b(add|create)\b.+\bfeature\b/i, 4],
  [/\b(generate|produce)\b.+\bcode\b/i, 5],
  [/\bfix\b.+\b(bug|issue|error|test|problem)\b/i, 4],
  [/\b(refactor|rewrite|re-write)\b/i, 4],
  // ── Standalone strong verbs ───────────────────────────────────────────
  [/\bimplement\b/i, 3],
  [/\bdebug\b/i, 3],
  [/\bdeploy\b/i, 5], // weight 5 so single-word "deploy" (len 6) survives -2 short-text penalty → score 3
  [/\bpatch\b/i, 3],
  // ── Code-writing phrases ──────────────────────────────────────────────
  [/\bwrite\s+(me\s+)?(a|an|some|the)\b/i, 4],
  [/\bwrite\s+(code|tests?|unit\s+tests?)\b/i, 5],
  [/\bcreate\s+(a|an)\s+file\b/i, 4],
  [/\bwrite\s+(a|an)\s+file\b/i, 4],
  [/\bedit\s+(the|this)\s+(file|code)\b/i, 4],
  [/\bmodify\s+the\s+code\b/i, 4],
  [/\bchange\s+the\s+code\b/i, 4],
  [/\bupdate\s+the\s+code\b/i, 3],
  // ── Tool hints ────────────────────────────────────────────────────────
  [/\buse\s+(write_file|edit_file)\b/i, 5],
  [/\buse\s+execute_shell\b/i, 3],
  [/\brun\s+this\s+command\b/i, 3],
  [/\binstall\b.+\bpackage\b/i, 3],
  [/\bnpm\s+install\b/i, 3],
  [/\bpip\s+install\b/i, 3],
  // ── Chinese equivalents (no \b — CJK chars don't have word boundaries) ─
  // NOTE: no /g flag — RegExp.test() with /g is stateful (lastIndex leaks across calls)
  [/(写|创建|实现|编写|生成).{0,6}(函数|类|代码|脚本|程序|测试|文件|模块|组件|接口)/, 5],
  [/(帮我写|帮我实现|帮我做|帮我弄)/, 4],
  [/写个/, 4],
  [/创建个/, 4],
  [/实现个/, 4],
  [/重构/, 4],
  [/(修复|改|修改).{0,6}(bug|代码|问题|错误)/, 4],
  [/(?:(?<!修)修复|修复(?!复))/, 3], // "修复" but not overlapping with longer patterns
  [/改代码/, 4],
  [/修改代码/, 4],
  [/添加功能/, 3],
  [/增加功能/, 3],
  [/(编译|部署|删除)/, 2],
];

// ── Non-code indicators (subtract from score) ─────────────────────────────
// These help distinguish "explain how code works" from "write code".
const NON_CODE_PATTERNS: Array<[RegExp, number]> = [
  [/\b(what|how|why|when|where|who|can|could|would|should|do|does|is|are|was|were)\b.{0,30}\?/i, -3],
  [/\bexplain\b/i, -3],
  [/\btell\s+me\s+(about|why|how)\b/i, -3],
  [/\bhelp\s+me\s+understand\b/i, -3],
  [/\bdescribe\b/i, -2],
  [/\bdefinition\s+of\b/i, -2],
  [/\bmeaning\s+of\b/i, -2],
  [/\bdifference\s+between\b/i, -2],
  [/\bcompare\b/i, -2],
  [/\byour\s+opinion\b/i, -3],
  [/\bdo\s+you\s+think\b/i, -2],
  [/\bis\s+it\s+possible\b/i, -2],
  // Chinese (no \b for CJK) — no /g flag to avoid stateful lastIndex
  [/(什么是|如何|怎么|为什么)/, -2],
  [/(解释|告诉我|介绍一下)/, -3],
  [/(区别|是否可以)/, -2],
  [/(你觉得|你的意见)/, -2],
  [/(是谁|在哪里)/, -3],
  [/[？?]$/, -2],
  // Greetings / small talk
  [/\b(hello|hi|hey|good\s+(morning|afternoon|evening))\b/i, -4],
  [/\bhow\s+are\s+you\b/i, -5],
  [/\bnice\s+to\s+meet\s+you\b/i, -5],
  [/\b(thank\s+you|thanks|bye|goodbye|see\s+you)\b/i, -4],
  // Chinese greetings (no \b for CJK) — no /g flag
  [/(你好|您好|早上好|下午好|晚上好)/, -4],
  [/(谢谢|再见|嗨)/, -4],
];

// ── Scoring threshold ──────────────────────────────────────────────────────
// A score >= CODE_THRESHOLD classifies the request as a code task.
const CODE_THRESHOLD = 3;

// ── Complexity scoring ─────────────────────────────────────────────────────
// Three-tier complexity assessment for dynamic model routing:
//   simple  (0-2):   quick edits, single-file changes, questions
//   medium  (3-5):   multi-step coding, bug fixes, refactors
//   complex (6+):    architecture, multi-file features, security, migrations

const COMPLEXITY_HIGH_PATTERNS: Array<[RegExp, number]> = [
  [/\b(架构|设计|重构|refactor|architect|design|complex|complicated)\b/i, 3],
  [/\b(multiple|multi|several|many)\s+(files?|components?|modules?|classes?)\b/i, 2],
  [/\b(security|auth|authentication|authorization|oauth|jwt|sql injection|xss)\b/i, 3],
  [/\b(migration|migrate|upgrade|breaking change)\b/i, 2],
  [/\b(debug|investigate|trace|profile|performance)\b/i, 1],
  [/\b(add.{0,30}feature|implement.{0,30}system|build.{0,30}(api|service|pipeline))\b/i, 2],
  [/\b(从头|从零|full.?stack|end.?to.?end|e2e)\b/i, 2],
  [/\b(database|数据库|schema|数据模型)\b/i, 2],
  [/\b(concurrency|并发|parallel|并行|async|异步)\b/i, 1],
  [/\b(memory leak|内存泄漏|race condition|竞态)\b/i, 2],
  [/\b(deploy|deployment|CI\/CD|docker|kubernetes|k8s)\b/i, 2],
  [/(实现.{0,10}(系统|平台|服务|框架)|implement.{0,10}(system|platform|service|framework))/i, 3],
];

const COMPLEXITY_LOW_PATTERNS: Array<[RegExp, number]> = [
  [/^(what|how|why|explain|describe|tell|list|show)\b/i, -2],
  [/^(是什么|怎么|为什么|解释|列出|显示)/, -2],
  [/\b(quick|simple|small|tiny|minor|typo|rename|format)\b/i, -2],
  [/^(继续|continue|go on|next|下一步)[\s!！。.]*$/i, -3],
  [/\b(fix typo|rename|format code|add comment|update doc)\b/i, -2],
  [/\b(单行|一行|one.?line|single.?line)\b/i, -2],
];

export type ComplexityTier = 'simple' | 'medium' | 'complex';

export interface ComplexityResult {
  tier: ComplexityTier;
  score: number;   // raw complexity score
  isCode: boolean; // whether it's a code task at all
  reason: string;
}

/**
 * Full classification: is this a code request, and how complex is it?
 *
 * Returns a three-tier complexity score for dynamic model routing:
 * - simple:  low-complexity tasks → flash model, thinking disabled
 * - medium:  standard coding tasks → pro model (or user's choice)
 * - complex: high-complexity tasks → pro model, thinking enabled
 */
export function classifyComplexity(text: string): ComplexityResult {
  if (!text || typeof text !== 'string') {
    return { tier: 'simple', score: 0, isCode: false, reason: 'empty input' };
  }

  let codeScore = 0;
  let complexityScore = 0;

  // ── Score code patterns ──────────────────────────────────────────────
  for (const [pattern, weight] of CODE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      codeScore += weight;
    }
  }

  // ── Score non-code patterns ──────────────────────────────────────────
  for (const [pattern, penalty] of NON_CODE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      codeScore += penalty;
    }
  }

  // ── Heuristic: very short messages are unlikely to be code requests ──
  if (text.trim().length < 8) {
    codeScore -= 2;
  }

  const isCode = codeScore >= CODE_THRESHOLD;

  if (!isCode) {
    return { tier: 'simple', score: codeScore, isCode: false, reason: 'non-code request' };
  }

  // ── Base complexity from code score ──────────────────────────────────
  complexityScore = Math.max(0, codeScore - CODE_THRESHOLD);

  // ── Add high-complexity signals ──────────────────────────────────────
  for (const [pattern, weight] of COMPLEXITY_HIGH_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      complexityScore += weight;
    }
  }

  // ── Subtract low-complexity signals ──────────────────────────────────
  for (const [pattern, penalty] of COMPLEXITY_LOW_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      complexityScore += penalty;
    }
  }

  // ── Length bonus: longer tasks tend to be more complex ───────────────
  const len = text.trim().length;
  if (len > 200) complexityScore += 2;
  else if (len > 100) complexityScore += 1;
  else if (len <= 60) complexityScore -= 1;

  // ── Determine tier ───────────────────────────────────────────────────
  let tier: ComplexityTier;
  let reason: string;
  if (complexityScore >= 6) {
    tier = 'complex';
    reason = `high complexity (score: ${complexityScore}) — multi-file, architecture, or security task`;
  } else if (complexityScore >= 3) {
    tier = 'medium';
    reason = `medium complexity (score: ${complexityScore}) — multi-step coding task`;
  } else {
    tier = 'simple';
    reason = `low complexity (score: ${complexityScore}) — simple edit or query`;
  }

  return { tier, score: complexityScore, isCode: true, reason };
}

/**
 * Classify whether a user's request is a "code writing/production" task.
 * @deprecated Use classifyComplexity() for three-tier scoring.
 */
export function is_code_request(text: string): boolean {
  return classifyComplexity(text).isCode;
}
