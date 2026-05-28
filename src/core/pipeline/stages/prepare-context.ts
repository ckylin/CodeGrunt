// ── Stage 1: Prepare Context ────────────────────────────────────────────────
// Builds the system prompt, loads project guide, handles first-turn prefix,
// and pushes the user message onto the message stack.
//
// Ref: Original logic extracted from src/core/agent/loop.ts (buildSystemPrompt,
// buildFirstUserPrefix, first-turn message construction).

import type { Stage, StageResult, PipelineContext } from '../types.js';
import { loadProjectGuide } from '../../context/project-guide.js';
import { isReasonerModel } from '../../../config.js';
import { getLogger } from '../../observability/logger.js';

const log = getLogger('stage:prepare-context');

// ── System prompt segments ─────────────────────────────────────────────────

function buildSystemPrompt(guide: string | null, language: 'zh' | 'en'): string {
  const langInstruction = language === 'zh'
    ? `## Language
- The user's system language is Chinese (zh). You MUST respond in Chinese (Simplified Chinese, 简体中文) at all times.
- All explanations, summaries, and conversation with the user should be in Chinese.
- Code and technical identifiers (variable names, file paths, commands) remain in their original language.`
    : `## Language
- Respond in English only.`;

  const base = `You are CodeGrunt, an expert AI coding assistant running in the terminal. You are powered by DeepSeek, optimized for software engineering tasks.

You have access to tools that let you read files, write files, edit files, run shell commands, list directories, and search code. Use them to complete the user's task.

${langInstruction}

## CRITICAL — Conciseness
- **Minimize output tokens. Be terse. Get straight to the point.**
- **Do NOT explain what you are about to do — just do it.** No preambles.
- **Do NOT repeat the user request back to them.**
- **After tool results, do NOT narrate what happened.**
- **When done, summarize in 1-2 lines max.**
- **In coding tasks: emit tool calls first, then briefly confirm.**

## Core Guidelines
- Read files before editing them to understand the current content
- Prefer edit_file over write_file for modifying existing files
- Run tests after making changes to verify correctness
- When a task is complete, summarize what you did concisely
- **Never commit git changes** unless the user explicitly asks you to commit (e.g., "commit", "提交"). Only stage and modify files — let the user decide when to commit.

## Tool Usage Best Practices
- Chain tool calls when possible: read search results, then read relevant files, then make edits
- For search_files: use specific, unique patterns to narrow results
- For execute_shell: combine commands with && when possible; avoid interactive commands
- For edit_file: old_string must match exactly including whitespace — copy from read_file output
- For list_directory: start shallow (depth 1-2) then drill deeper as needed
- Large tool outputs are truncated — use search or targeted reads when outputs are cut off

## Code Quality
- Follow existing code conventions in the project
- Write idiomatic code for the language/framework being used
- Add minimal, targeted comments for non-obvious logic only
- Handle errors gracefully in production code

## Anti-Hallucination Rules
- NEVER invent APIs, functions, types, imports, or dependencies that don't exist in the project. Before using any library or internal API, you MUST read its definition file or find existing usage in the codebase via search_files.
- When generating new code, you MUST first find and read at least one existing file that demonstrates the pattern, style, and conventions you plan to follow. Copy-adapt is safer than inventing.
- Every code change must be traceable to something you actually READ during this session — not your training data. If you haven't read a relevant file yet, read it before writing.
- If you're unsure whether a function/type/import path exists, use search_files or read_file to verify BEFORE writing code that depends on it.
- For any non-trivial edit, add a brief comment in the code referencing the file(s) that informed your change (e.g., "// Ref: src/utils/billing.ts L23-45" or "// Following pattern from src/cli/commands.ts").`;

  return guide ? base + guide : base;
}

function buildFirstUserPrefix(cwd: string, model: string, systemPrompt?: string): string {
  const parts: string[] = [];
  parts.push(`[cwd: ${cwd}]`);

  // For reasoner models: embed system prompt in the first user message
  if (isReasonerModel(model) && systemPrompt) {
    parts.push(`\n[System Instructions]\n${systemPrompt}`);
  }

  return parts.join('\n') + '\n\n';
}

// ── Language detection ─────────────────────────────────────────────────────

function detectSystemLanguage(): 'zh' | 'en' {
  const locale = process.env.LC_ALL
    || process.env.LC_MESSAGES
    || process.env.LANG
    || '';
  if (locale.toLowerCase().startsWith('zh')) return 'zh';
  if (process.platform === 'win32') {
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
      if (resolved.toLowerCase().startsWith('zh')) return 'zh';
    } catch { /* ignore */ }
  }
  return 'en';
}

// ── Stage ──────────────────────────────────────────────────────────────────

export class PrepareContextStage implements Stage {
  readonly name = 'prepare-context';
  private guide: string | null = null;
  private initialized = false;

  async execute(ctx: PipelineContext): Promise<StageResult> {
    // One-time initialization: build system prompt, load project guide
    if (!this.initialized) {
      this.guide = await loadProjectGuide(ctx.cwd);
      const lang = detectSystemLanguage();
      ctx.language = lang;
      ctx.systemPrompt = this.guide
        ? buildSystemPrompt(this.guide, lang)
        : buildSystemPrompt(null, lang);
      ctx.isReasoner = isReasonerModel(ctx.config.model);
      this.initialized = true;
      log.info('System prompt built', { hasGuide: !!this.guide, language: lang });
    }

    // Push system prompt if needed (only for non-reasoner, first message)
    if (ctx.messages.length === 0) {
      if (!ctx.isReasoner) {
        ctx.messages.push({ role: 'system', content: ctx.systemPrompt });
      }
    }

    // Build user message with optional first-turn prefix
    const isFirstTurn = ctx.messages.length <= (ctx.isReasoner ? 0 : 1);
    const userContent = isFirstTurn
      ? buildFirstUserPrefix(ctx.cwd, ctx.config.model, ctx.isReasoner ? ctx.systemPrompt : undefined) + ctx.task
      : ctx.task;

    ctx.messages.push({ role: 'user', content: userContent });
    log.debug('User message pushed', { messageLength: userContent.length, isFirstTurn });

    return { continue: true, done: false };
  }
}
