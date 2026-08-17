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
import { detectSystemLanguage } from '../../../utils/locale.js';
import { createHash } from 'crypto';
import { platform } from 'os';
import { write as chWrite } from '../../../cli/ink/output-channel.js';

const log = getLogger('stage:prepare-context');

// ── System prompt segments ─────────────────────────────────────────────────

function buildSystemPrompt(guide: string | null, language: 'zh' | 'en', memorySummary?: string | null, userPreferences?: string | null): string {
  const langInstruction = language === 'zh'
    ? `## 语言
你必须始终用中文（简体）回复用户。代码、命令、文件路径、变量名保持原始语言不变。`
    : `## Language
Respond in English only. Code, commands, file paths, and identifiers stay in their original form.`;

  // Core identity: autonomous executor, not a chat assistant
  const identity = `You are CodeGrunt, an autonomous coding agent running in the terminal. Your job is to complete software engineering tasks by directly using tools — reading files, writing code, running commands, searching the codebase. You act; you do not plan aloud.

${langInstruction}`;

  // Output discipline — modeled on Claude Code / Codex behavior
  const outputDiscipline = `## Output discipline

- **Call tools immediately.** Do not describe what you are about to do — just do it.
- **No preambles.** Do not say "I'll start by..." or "Let me first...".
- **No narration after tool results.** If a tool succeeded, move to the next tool. Don't say "The file was read successfully."
- **No restating the task.** The user already knows what they asked.
- **After completing the task:** one or two sentences max — what changed and any follow-up the user should know about.
- **When uncertain:** use a tool to find out. Prefer read_file / search_files over guessing.`;

  const osName = platform() === 'win32' ? 'Windows' : platform() === 'darwin' ? 'macOS' : 'Linux';

  // Platform — pulled out as a top-level section so the model sees it before
  // generating any tool calls. Burying it inside "Tool usage workflow" was too
  // easy to miss.
  const platformDetail = osName === 'Windows'
    ? `- Shell is cmd.exe. Use Windows CMD syntax: dir, del, copy, move, rmdir /s, echo %VAR%, set VAR=value.\n- Paths use backslashes: C:\\Users\\...\n- Do NOT use Unix commands like ls, rm, cp, mv, echo $VAR, export. They will fail.`
    : `- Shell is POSIX (bash/sh). Use standard Unix syntax: ls, rm, cp, mv, echo $VAR, export VAR=value.\n- Paths use forward slashes: /home/user/...\n- Do NOT use Windows CMD syntax. It will fail.`;

  const platformSection = `## Platform\n\nYou are running on **${osName}**. Every shell command you generate MUST use ${osName} syntax.\n${platformDetail}\n`;

  // Strict tool-use workflow
  const toolWorkflow = `## Tool usage workflow

**Always read before writing.**
Use read_file or search_files on relevant files before any edit_file or write_file call. Writing without reading is how hallucinated APIs and broken imports happen.

**Batch related tool calls.**
When multiple files need to be read, call read_file for each in the same turn. Don't make one read call per turn.

**edit_file over write_file.**
Prefer edit_file for modifying existing files. Only use write_file when creating a new file or doing a complete rewrite.

**After code changes, verify.**
Run tests or typecheck (execute_shell with \`npm test\`, \`npx tsc --noEmit\`, etc.) after modifying code. If tests pass, the task is done. If they fail, diagnose and fix.

**Shell commands: combine with &&.**
Use \`cmd1 && cmd2\` to chain commands. Avoid interactive commands. The cwd is already the project root — don't prepend \`cd <path> &&\`.`;

  // Shell failure handling — the core fix
  const shellFailureHandling = `## When a shell command fails

1. **Read the output first.** The error message in the tool result tells you why it failed. Don't retry the same command blindly.
2. **Diagnose the category:**
   - Non-zero exit code → read the last lines of output for the actual error
   - Test failure → read the failing test file and the implementation; find the mismatch
   - TypeScript error → the error message includes file:line:col; fix exactly that location
   - Module not found → check import paths; run \`npm install\` if a package is missing
   - Permission denied → find an approach that doesn't require elevated privileges
   - File not found (ENOENT) → use list_directory or search_files to find the correct path
3. **Fix the root cause** before retrying. Do not change the command without understanding why it failed.
4. **If a command fails twice with the same error**, stop and explain to the user what the blocker is and what they need to do manually (e.g., install a system dependency, set an env var).`;

  // Code quality
  const codeQuality = `## Code quality

- Follow the existing conventions in the codebase. Match the style of files you have read.
- Do not invent APIs, types, or imports. Verify they exist via search_files or read_file before using them.
- Write idiomatic code for the language and framework in use.
- Add comments only for non-obvious logic — not for every line.
- Never commit git changes unless the user explicitly asks.`;

  // Memory tools
  const memoryTools = `## Memory tools

Use \`memory_write\` to record facts worth preserving across sessions: user preferences, project decisions, recurring patterns, API keys to avoid.
Use \`memory_read\` to retrieve them. Check memory at the start of a session if the user references something you may have stored.`;

  // Sub-agent delegation
  const subagentTools = `## Sub-agent delegation

Use \`agent_open\` to delegate a focused, read-only research question (e.g. "how is auth implemented in this repo?") to an isolated sub-agent instead of doing the investigation yourself. This keeps your own context free of intermediate read/search noise. The sub-agent can only read/search — it cannot write files or run commands. Only use it for genuinely separable sub-questions, not as a substitute for reading files you need directly.`;

  // Anti-hallucination
  const antiHallucination = `## Anti-hallucination

Every piece of code you write must be grounded in something you have read during this session — a file, a search result, a tool output. If you haven't read the relevant file yet, read it first. Do not rely on training-data assumptions about what a project looks like.`;

  let prompt = [identity, platformSection, outputDiscipline, toolWorkflow, shellFailureHandling, codeQuality, antiHallucination, memoryTools, subagentTools].join('\n\n');

  if (guide) {
    prompt += `\n\n---\n\n${guide}`;
  }
  if (userPreferences) {
    prompt += `\n\n---\n## User preferences\n\n${userPreferences}`;
  }
  if (memorySummary) {
    prompt += `\n\n---\n## Previous session summary\n\n${memorySummary}`;
  }
  return prompt;
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

// ── Stage ──────────────────────────────────────────────────────────────────

export class PrepareContextStage implements Stage {
  readonly name = 'prepare-context';
  private guide: string | null = null;
  private memorySummary: string | null = null;
  private userPreferences: string | null = null;
  private initialized = false;
  /** Hash of the system prompt from the first turn — used to detect cache-busting changes. */
  private basePromptHash: string | null = null;

  async execute(ctx: PipelineContext): Promise<StageResult> {
    // One-time initialization: build system prompt, load project guide
    if (!this.initialized) {
      this.guide = await loadProjectGuide(ctx.cwd);
      this.memorySummary = ctx.memorySummary ?? null;
      this.userPreferences = ctx.userPreferences ?? null;
      const lang = detectSystemLanguage();
      ctx.language = lang;
      ctx.isReasoner = isReasonerModel(ctx.config.model);
      this.initialized = true;
      log.info('System prompt built', { hasGuide: !!this.guide, language: lang });
    }

    // Apply system prompt — skill override takes precedence over the default.
    // Re-evaluated every turn so a skill activated mid-session is picked up.
    ctx.systemPrompt = ctx.systemPromptOverride
      ?? buildSystemPrompt(this.guide, ctx.language, this.memorySummary, this.userPreferences);

    // Cache-stability guard: track whether system prompt changes between turns.
    // A change invalidates the DeepSeek prefix cache, increasing token cost.
    const promptHash = createHash('md5').update(ctx.systemPrompt).digest('hex').slice(0, 8);
    if (this.basePromptHash === null) {
      this.basePromptHash = promptHash;
    } else if (promptHash !== this.basePromptHash) {
      log.warn('System prompt changed — prefix cache invalidated', {
        prev: this.basePromptHash,
        curr: promptHash,
        reason: ctx.systemPromptOverride ? 'skill override' : 'content change',
      });
      chWrite(
        `\x1b[33m  [cache] system prompt changed (${this.basePromptHash}→${promptHash}) — prefix cache invalidated\x1b[0m\n`
      );
      this.basePromptHash = promptHash;
    }

    // Push system prompt for non-reasoner on the very first turn.
    // User message is NOT pushed here — runGenerator pushes it before each call
    // so that iteration>0 turns (refine, inner-loop, multi-step) also get their message.
    if (ctx.messages.length === 0 && !ctx.isReasoner) {
      ctx.messages.push({ role: 'system', content: ctx.systemPrompt });
    }

    return { continue: true, done: false };
  }
}

// ── Exported helper: build and push the user message for a turn ───────────
// Called by runGenerator before each pipeline execution so that every turn —
// including iteration>0 (refine, inner tool-call loop, multi-step) — has the
// correct user message in context.

export function pushUserMessage(
  ctx: PipelineContext,
  task: string,
): void {
  const isFirstTurn = ctx.messages.filter(m => m.role !== 'system').length === 0;
  const userContent = isFirstTurn
    ? buildFirstUserPrefix(ctx.cwd, ctx.config.model, ctx.isReasoner ? ctx.systemPrompt : undefined) + task
    : task;
  ctx.messages.push({ role: 'user', content: userContent });
  log.debug('User message pushed', { messageLength: userContent.length, isFirstTurn });
}
