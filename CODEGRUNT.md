# CODEGRUNT.md — Developer Guide

## Build & Dev Commands

```bash
# Development (watch mode, auto-reload on changes)
npm run dev

# TypeScript compilation to dist/
npm run build

# Type-check only (no emit)
npm run typecheck

# Full test suite
npm test

# Single test file
npx vitest run tests/tools/read_file.test.ts

# Run compiled output
npm start

# Global link for local CLI testing
npm link
```

**Engine requirement**: Node.js >= 18.  
**Module system**: ESM (`"type": "module"`).  
**Compiler target**: ES2022, JSX support (`react-jsx` via `ink`).  
**Module resolution**: `bundler` — works with `tsx` (dev) / `tsc` (build).

---

## Architecture

### Entry Point & CLI Layer (`src/cli/`)

```
index.ts  →  Commander.js program
  ├─ 0 args  →  startRepl()
  ├─ 1 arg   →  runAgentLoop() one-shot
  ├─ "update" subcommand  →  runUpdate()
  └─ "skills" subcommand  →  install / remove / list skills
```

`index.ts` is the binary entry. It loads config, generates a `runId` for trace correlation, initializes the DeepSeek provider, creates a logger via `createLogger('cli', runId)`, and branches into REPL, one-shot, update check, or skill management.

**Ink/React Terminal UI** (`ink/`) — Modern React-based terminal components using the `ink` library:
- `PromptInput.tsx` — Main input with cursor movement, history navigation, autocomplete dropdown, Ctrl+C cancel, and Ink `useInput` key bindings
- `Dropdown.tsx` — Autocomplete overlay with `❯` indicator, skill/builtin/file kind coloring, 8-item limit
- `ListPicker.tsx` — Arrow-key selector for model/config selection
- `useAutocomplete.ts` — File path completion (`@` references), slash command completion, skill name completion
- `useHistory.ts` — Persistent command history with up/down navigation
- `types.ts` — Shared Ink component types (`InputResult`, `DropdownItem`, `PromptInputProps`, etc.)

**REPL** (`repl.ts`, `input.ts`) uses Node.js `readline` with:
- Tab completion for file paths and slash commands
- `@`-reference auto-completion (files/directories)
- Input tuple detection (parenthesized multi-line mode)
- Session usage display in the prompt line

**`at-resolver.ts`** — Parses `@file.ts`, `@src/`, `@https://...` tokens from user input. Resolves them to content (reads files, lists directories up to 20 entries, fetches URLs) and appends formatted attachments to the message body. Directory scanning skips `node_modules`, `.git`, `dist`, `.next`, `__pycache__`, `.cache`.

**`commands.ts`** — Slash command handler. Returns discriminated unions: `handled`, `clear`, `config_changed`, `model_changed`, `skill_run`, `skills_reload`, or `not_a_command`. Commands include `/init`, `/model`, `/compact`, `/clear`, `/config`, `/cost`, `/balance`, `/reasoning`, `/effort`, `/review`, `/skills`, and skill execution via `/skill-name`.

**`skills.ts`** — Loads user-defined skills from `~/.codegrunt/skills/` (global) and `.codegrunt/skills/` (project-local). Each skill is a `.md` file or a directory with `skill.md` containing frontmatter (`name`, `description`, `system`) and a prompt template body. Supports installing skills from `.zip` files. Skills appear in tab completion, the `/help` menu, and are auto-discovered by the Intentor.

**`setup.ts`** — Interactive first-run wizard: collects API key, model selection (lists DeepSeek models), token limit, reasoning effort. Writes to `~/.codegrunt/config.json`.

**`update.ts`** — Checks npm registry for new versions and upgrades the global installation via `npm install -g codegrunt@latest`.

### Agent Loop (`src/core/agent/loop.ts`)

Implements a **P/G/E (Planner / Generator / Evaluator) + Intentor** architecture powered by a Harness-style pipeline engine:

**Phase 0 — Intentor** (`intentor.ts`): Classifies user intent into three paths:
- **Skill match** → `runSkillFlow`: Applies skill system prompt + content, then chat-style generation
- **Coding** → `runCodingFlow`: P/G/E pipeline with plan → step-by-step → evaluate → refine
- **Chat** → `runChatFlow`: Direct generator pipeline, skipping Planner/Evaluator

Intentor uses fast heuristics first (keyword patterns, continuation detection, skill keyword overlap) with LLM fallback only when confidence is low.

**Coding Flow — P/G/E**:
1. **Planner** (`planner.ts`): Decomposes complex tasks into 2-5 steps with low-temperature JSON output. Injects the real tool list into the prompt; filters invalid `toolsHint` values post-parse. Skipped for short tasks (≤50 chars) and continuation signals
2. **Generator**: Pipeline engine executes each step sequentially — now with **inner iteration** (multi-turn tool calls per step, not just 1 turn)
3. **Evaluator** (`evaluator.ts`): Quality check / plan adherence / hallucination detection across **14 error patterns**. Auto-runs `tsc --noEmit` on TypeScript projects after any write or edit. Fails → injects feedback and retries (max 3). After 3 failed retries the user is prompted rather than silently continuing. `pruneRefineMessages()` cleans eval feedback between steps
4. `sessionHasRead` tracking prevents redundant file reads across turns

**Chat Flow**: Skips Planner/Evaluator, uses Generator pipeline iteratively (up to 30 iterations). Prints fallback text if model returns empty.

Tracks session token usage (`addUsage`, `getSessionUsage`, `resetSessionUsage`) for `/cost` reporting.

### Pipeline Engine (`src/core/pipeline/`)

Inspired by Harness CI/CD pipelines. Each agent interaction is decomposed into 5 stages sharing a `PipelineContext`:

| Stage | File | Responsibility |
|---|---|---|
| PrepareContext | `prepare-context.ts` | Build system prompt, inject project guide, init messages |
| StreamResponse | `stream-response.ts` | Stream LLM call, accumulate text/reasoning/tool calls |
| ProcessToolCalls | `process-tools.ts` | Parse tool calls, execute via executor, inject results |
| ProcessToolHelpers | `process-tools-helpers.ts` | yes-for-all session-level state management |
| PostProcess | `post-process.ts` | Blind-write warnings, token stats, final output formatting |

### Context Manager (`src/core/context/manager.ts`)

Manages conversation message array with a **token budget**. When the budget is exceeded, it truncates oldest messages (preserving system prompt). Two budget constants exist in `config.ts`:
- `CONTEXT_BUDGET` — for reasoner models (larger)
- `CHAT_CONTEXT_BUDGET` — for standard chat models (smaller)

**Compaction** triggers at **50%** of the token budget (previously 80%), or when the conversation exceeds **30 non-system messages**. Compaction keeps the **15 most recent messages** (was 6) and generates a summary of up to **1500 tokens** (was 512).

**`project-guide.ts`** — Scans for `CODEGRUNT.md` or `CLAUDE.md` in the working directory and injects it into the system prompt as codebase-level context.

### Tool System (`src/core/tools/`)

Eight built-in tools:

| Tool | File | Destructive? | Notes |
|---|---|---|---|
| `read_file` | `read_file.ts` | No | Optional `start_line`/`end_line` for range reading; 100 KB limit; files >100 KB show line count + instructions |
| `write_file` | `write_file.ts` | **Yes** — diff preview + confirm | |
| `edit_file` | `edit_file.ts` | **Yes** — diff preview + confirm | |
| `execute_shell` | `execute_shell.ts` | **Yes** — confirm | `timeout_ms` capped at 300 s (5 min); reports bytes captured on timeout |
| `list_directory` | `list_directory.ts` | No | Default 500 entries (was 200); `max_entries` param up to 2000 |
| `search_files` | `search_files.ts` | No | New `is_regex: boolean` and `include_hidden: boolean` params |
| `memory_write` | `memory.ts` | No | Writes to the agent's persistent memory store |
| `memory_read` | `memory.ts` | No | Reads from the agent's persistent memory store |

**`registry.ts`** — Tool definitions (name, description, JSON Schema parameters) mapped to implementations. This is what gets sent to the LLM as available functions. External callers use `getToolDefinitions()` and `getToolByName()` only; `ToolRegistry` is no longer a public export.

### Provider System (`src/providers/`)

Providers implement the `LLMProvider` interface defined in `types.ts`:

```typescript
interface LLMProvider {
  readonly id: string;
  stream(messages: Message[], options: RequestOptions): AsyncIterable<StreamChunk>;
}
```

**DeepSeek provider** (`deepseek/provider.ts`, `deepseek/client.ts`) wraps the `openai` npm package pointed at DeepSeek's API base URL. It handles:
- Stream mode with tool call delta accumulation
- Reasoning content extraction (for reasoner models); `reasoning_content` is only included for the last assistant message, not the full history, to reduce prompt size
- Token usage tracking per request via `src/core/usage.ts`
- **Exponential backoff retry**: up to 3 retries on 429, 5xx, or `ECONNRESET` errors, with delays of 1 s → 2 s → 4 s

**Observability** (`src/core/observability/`)

**Logger v2** (`logger.ts`):
- **File transport**: Structured JSONL logs written to `~/.codegrunt/logs/`
- **Trace IDs**: Unique `runId` for correlating entries across a single session. Created via `createLogger('namespace', runId)`
- **Log rotation**: Keeps last 5 files, max 5 MB each
- **Environment**: `CODEGRUNT_LOG_LEVEL` (debug/info/warn/error), `CODEGRUNT_LOG_FILE` (0/false to disable), `CODEGRUNT_VERBOSE`

**Metrics** (`metrics.ts`): Lightweight counters, timers, and snapshots for telemetry.

**EventBus** (`src/core/events/bus.ts`): Typed event bus covering pipeline/tool/LLM/conversation lifecycle events.

**Usage tracking** (`src/core/usage.ts`): Shared token usage module (`addUsage`, `getSessionUsage`, `getLastCallUsage`). Decoupled from both the provider and pipeline stages to avoid circular imports. `stream-response.ts` forwards real cache hit/miss token counts here.

### Utilities (`src/utils/`)

- **`billing.ts`** — Fetches account balance/usage from DeepSeek API, formats cost display with USD/CNY dual currency
- **`confirm.ts`** — Interactive yes/no prompt for destructive operations with diff preview
- **`display.ts`** — Markdown rendering in terminal, error formatting, diff display, plan/step/evaluation output
- **`interrupt.ts`** — Creates `AbortController` for Ctrl+C handling in both REPL and one-shot modes
- **`locale.ts`** — `detectSystemLanguage()` helper (extracted to avoid duplication)
- **`markdown.ts`** — Streaming Markdown-to-terminal renderer
- **`select.ts`** — Interactive list selector with arrow-key navigation
- **`constants.ts`** — Shared constants (accent color, etc.)

---

## Key Patterns & Conventions

### P/G/E + Intentor Architecture

The agent loop now has **four distinct execution paths**:
- `runSkillFlow` — for skill-matched tasks (applies skill system prompt)
- `runCodingFlow` — for coding tasks (Planner → Generator → Evaluator with inner iteration)
- `runChatFlow` — for chat tasks (Generator only, no evaluation)

### Discriminated Union Returns

Several modules (commands, input, tool executor) return tagged unions rather than throwing. Example from `commands.ts`:
```typescript
type SlashCommandResult =
  | { type: 'handled' }
  | { type: 'clear' }
  | { type: 'config_changed'; config: CodeGruntConfig }
  | { type: 'model_changed'; config: CodeGruntConfig }
  | { type: 'skill_run'; prompt: string; system?: string }
  | { type: 'skills_reload' }
  | { type: 'not_a_command' };
```
This keeps control flow at the call site explicit.

### Pipeline Architecture

All generator interaction goes through the Pipeline engine — a sequence of 5 independently testable stages sharing a `PipelineContext`:
```
PrepareContext → StreamResponse → ProcessToolCalls → PostProcess
```

### Config is Passed, Not Global

`CodeGruntConfig` is loaded once in `index.ts` and threaded through function arguments. Nothing imports config globally. The exception is `config.ts` which exports constants (`CONTEXT_BUDGET`, `CHAT_CONTEXT_BUDGET`) and predicate functions (`isReasonerModel`, `supportsReasoning`).

### Provider-Agnostic Agent Loop

The agent loop (`runAgentLoop`) takes an `LLMProvider` interface, not a concrete DeepSeek instance. Adding a new provider requires only implementing `LLMProvider` and wiring it into `index.ts`.

### `@`-Reference Resolution Happens Pre-LLM

`resolveAtReferences()` runs on raw user input before messages are constructed. References are stripped from the visible prompt text and appended as formatted blocks at the bottom of the message. This means the LLM sees the full content but the user's prompt remains readable.

### Destructive Operations Require Confirmation

Write/edit/shell tools compute a diff or display the command, call `confirm()`, and only proceed on explicit "yes". The agent loop has no ability to bypass this — confirmation is inside the tool executor, not the agent. "Yes for all" is managed via `process-tools-helpers.ts`.

### Model Selection Affects Budget and Behavior

`isReasonerModel()` in `config.ts` checks the model ID. Reasoner models get a larger context budget and support an `effort` parameter (controlled via `/reasoning` / `/effort` commands). This distinction flows through context manager initialization and provider request options.

### Skill Auto-Discovery

The Intentor automatically matches tasks to skills using keyword overlap (≥40% token match). Skills are also passed to the LLM-based classifier for more nuanced matching. Matched skills route to `runSkillFlow` which applies the skill's system prompt override.

### Continuation Detection

Short imperative phrases like "继续", "go on", "next" are detected by the Intentor and default to the coding path, skipping the Planner.

---

## Configuration

### Environment Variables

| Variable | Effect | Required |
|---|---|---|
| `DEEPSEEK_API_KEY` | API key for DeepSeek provider | Yes |
| `CODEGRUNT_MODEL` | Override default model ID | No |
| `CODEGRUNT_PROVIDER` | Override provider ID | No |
| `CODEGRUNT_MAX_TOKENS` | Max tokens per response | No |
| `CODEGRUNT_TEMPERATURE` | Response temperature (0-2) | No |
| `CODEGRUNT_BASE_URL` | Custom API base URL | No |
| `CODEGRUNT_REASONING_EFFORT` | R1 reasoning effort: `low` \| `medium` \| `high` | No |
| `CODEGRUNT_TOP_P` | Nucleus sampling (0-1) | No |
| `CODEGRUNT_FREQUENCY_PENALTY` | Repetition penalty (-2 to 2) | No |
| `CODEGRUNT_PRESENCE_PENALTY` | Topic diversity penalty (-2 to 2) | No |
| `CODEGRUNT_LOG_LEVEL` | Log level: `debug` \| `info` \| `warn` \| `error` | No |
| `CODEGRUNT_LOG_FILE` | Set to `0` or `false` to disable file logging | No |
| `CODEGRUNT_VERBOSE` | Enable verbose stderr output | No |

### Config File

`~/.codegrunt/config.json` — created by the setup wizard on first run. Stores:
```json
{
  "apiKey": "sk-...",
  "model": "deepseek-v4-pro",
  "provider": "deepseek",
  "maxTokens": 8192,
  "temperature": 0.2,
  "reasoningEffort": "medium",
  "topP": 1,
  "frequencyPenalty": 0,
  "presencePenalty": 0
}
```

### Project Guide Files

At startup, the context manager scans the working directory for `CODEGRUNT.md` (preferred) or `CLAUDE.md` (fallback). If found, the file content is prepended to the system prompt to give the LLM project-specific context.

### Skills Directory

`~/.codegrunt/skills/` (global) and `.codegrunt/skills/` (project-local) — each skill is a `.md` file with YAML frontmatter (`name`, `description`, `system`) and a Markdown body, or a directory containing `skill.md`. Install new skills via `codegrunt skills add -f <file.zip>`. Skills appear as slash commands in the REPL and are auto-discovered by the Intentor.

### Log Files

Structured JSONL logs are written to `~/.codegrunt/logs/` by default. Log rotation keeps the last 5 files (max 5 MB each). File logging can be disabled via `CODEGRUNT_LOG_FILE=0`.
