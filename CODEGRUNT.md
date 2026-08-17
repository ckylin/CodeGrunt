# CODEGRUNT.md — Developer Guide

> This file is loaded by CodeGrunt itself as the project guide for this
> repository. Keep it in sync with `src/`. The canonical developer-facing
> docs live in `docs/development-guide.md` (中文) / `docs/development-guide-en.md`
> (English).

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
  ├─ 0 args  →  startRepl()                 (interactive REPL, requires TTY)
  ├─ 1 arg   →  runAgentLoop() one-shot
  ├─ "update" subcommand  →  runUpdate()     (-c/--check, -y/--yes)
  └─ "skills" subcommand  →  add|install / remove|rm / list
  Options: -m/--model, --max-tokens, --resume [id], --version
```

`index.ts` is the binary entry. It loads config, generates a `runId` for trace
correlation, initializes the DeepSeek provider, creates a logger via
`createLogger('cli', runId)`, and branches into REPL, one-shot, update check,
or skill management. If no API key is configured, `runSetup()` (the first-run
wizard in `setup.ts`) runs first.

**Ink/React Terminal UI** (`ink/`) — a persistent React tree (`App.tsx`) owns
the terminal for the whole REPL session. `src/cli/ink/output-channel.ts` is the
output routing seam: in one-shot mode writes fall straight through to stdout;
once a sink is registered (REPL) writes are routed into Ink state so the
reconciler owns the live region.

| Component | Purpose |
|---|---|
| `App.tsx` | Persistent REPL tree: `<Static>` history + live tool line + streaming text + `<StatusBar>` + `<PromptInput>`/`<ListPicker>`. Returns an `AppHandle` (`promptForInput`, `setBusy`, `onCancelBusy`, `setTotalTokens`). |
| `PromptInput.tsx` | Main input: cursor movement, history navigation, autocomplete dropdown, busy mode (dimmed/blocked), Ctrl+C double-press cancel, Esc, bracketed paste. |
| `StatusBar.tsx` | `model · ⎇ branch · Nk tokens` on the left; `{elapsed}s · Esc to cancel` on the right while busy. |
| `Dropdown.tsx` | Autocomplete overlay with `❯` indicator, skill/builtin/file kind coloring, 8-item limit. |
| `ListPicker.tsx` | Arrow-key selector for model/config/trust-mode selection (delegated inside the App tree when mounted). |
| `useAutocomplete.ts` | File path (`@`) completion, slash command completion, skill name completion. |
| `useHistory.ts` | Persistent command history with up/down navigation. |
| `git-branch.ts` | `getCurrentGitBranch(cwd)` — cached current git branch for the StatusBar. |
| `paste.ts` | Bracketed-paste state machine (multi-line paste no longer misreads as Enter). |
| `types.ts` | Shared Ink component types (`InputResult`, `DropdownItem`, `PromptInputProps`, ...). |

**`at-resolver.ts`** — Parses `@file.ts`, `@src/`, `@"path with spaces"`,
`@https://...` tokens from user input. Resolves them to content (reads files,
lists directories up to 20 entries, fetches URLs) and appends formatted
attachments to the message body. Directory scanning skips `node_modules`,
`.git`, `dist`, `.next`, `__pycache__`, `.cache`.

**`commands.ts`** — Slash command handler. Returns discriminated unions:
`handled`, `clear`, `config_changed`, `model_changed`, `skills_reload`, or
`not_a_command`. The full command list is in the Slash Commands section below.
`branch-commands.ts` holds the `/branch`, `/tree`, `/switch`,
`/subagent-cache` handlers.

**`skills.ts`** — Loads user-defined skills from `.codegrunt/skills/` (project),
`.claude/skills/` (Claude Code-compatible), and `~/.codegrunt/skills/` (global),
in that priority order. Each skill is a `.md` file or a directory with
frontmatter (`name`, `description`, `system`, `mode: inline|subagent`) and a
prompt template body. Supports installing skills from `.zip` archives
(`codegrunt skills add -f <file.zip>`) and `createSkill()` via `/skills create`.

**`setup.ts`** — Interactive first-run wizard: collects API key, model
selection (lists DeepSeek models), token limit, reasoning effort. Writes to
`~/.codegrunt/config.json`.

**`update.ts`** — Checks npm registry for new versions and upgrades the global
installation via `npm install -g codegrunt@latest`.

**`init.ts`** — `/init` implementation: analyzes the codebase and generates a
`CODEGRUNT.md` project guide.

### Agent Loop (`src/core/agent/`)

Implements a **P/G/E (Planner / Generator / Evaluator) + Intentor** architecture
powered by a Harness-style pipeline engine. The agent core is split across
`loop.ts` (entry), `intentor.ts`, `planner.ts`, `generator.ts` (shared
generator), `evaluator.ts`, `chat-flow.ts`, `coding-flow.ts`, `skill-flow.ts`,
`complexity.ts` (request classifier / thinking router), `r1-harvester.ts`,
`subagent.ts` + `subagent-cache.ts`.

**Phase 0 — Intentor** (`intentor.ts`): Classifies user intent into three paths:
- **Skill match** → `runSkillFlow`: applies skill system prompt + content;
  `mode: 'subagent'` routes through the isolated read-only sub-agent loop
- **Coding** → `runCodingFlow`: P/G/E pipeline with plan → step → evaluate → refine
- **Chat** → `runChatFlow`: direct generator pipeline, skipping Planner/Evaluator

Intentor uses fast heuristics first (keyword patterns, continuation detection,
skill keyword overlap ≥40%) with LLM fallback only when confidence is low
(light `deepseek-v4-flash` model, `maxTokens: 256`, `temperature: 0`).

**Model auto-routing** (`selectModelForTask`): only for `deepseek-v4-*` models.
Non-coding/skill tasks and simple/≤60-char tasks route to flash; complex-coding
signals route to pro; never routes to a reasoner model.

**Thinking-mode router** (`complexity.ts`): `classifyComplexity(task)` returns a
`simple | medium | complex` tier. When the task is code: simple → forces
`thinking: 'disabled'`; complex → forces `thinking: 'enabled'` when
`config.autoThinkingMode` (default true); medium → untouched.

**Coding Flow — P/G/E**:
1. **Planner** (`planner.ts`): Decomposes complex tasks into 2-5 steps with
   low-temperature (0.1) JSON output. Injects the real tool list into the
   prompt; filters invalid `toolsHint` values post-parse. Skipped for short
   tasks (≤50 chars) and continuation signals
2. **Generator** (`generator.ts`): shared `runGenerator()` — a 4-stage pipeline
   (see below) executed per step, with **inner iteration** (multi-turn tool
   calls per step, bounded by `MAX_ITERATIONS = 30`)
3. **Evaluator** (`evaluator.ts`): pure structural quality check across 14
   error patterns; runs `src/core/lsp/checker.ts` diagnostics
   (tsc/pyright/go vet/cargo check/eslint) after write/edit. Fails → injects
   feedback and retries (max `MAX_REFINE_RETRIES = 3`), then prompts the user
   whether to continue. `pruneRefineMessages()` cleans eval feedback between steps
4. `sessionHasRead` tracking prevents redundant file reads across turns

**Chat Flow**: Skips Planner/Evaluator, uses Generator pipeline iteratively
(up to 30 iterations). Prints fallback text if model returns empty.

**Skill Flow**: Applies skill system prompt + content, then chat-style
generation with tool call iteration. `mode: 'subagent'` skills run in the
isolated read-only sub-agent loop instead.

**System prompt stability**: Built once per session, never mutated (maximizes
DeepSeek prompt cache hits). For R1 reasoner models, the system prompt is
embedded in the first user message (R1 rejects the `system` role).

**Model branching**: `isReasonerModel()` detects R1 variants;
`supportsReasoning()` matches V4/Pro models that emit `reasoning_content`.
Context budgets: 100k tokens for reasoning models, 90k for chat models.
`reasoning_content` is only sent back for the last assistant message (not full
history) to reduce token cost.

**Auto-compaction** (`loop.ts` → `src/core/context/compact.ts`): at the start
of each turn, if `context.needsCompact` is set (70% of token budget or >40
non-system messages) and `config.autoCompact` (default true), messages are
hierarchically chunk-summarized (chunks of ~12k tokens, per-chunk summary ≤400
tokens, merged final summary ≤1500 tokens, keeps the 15 most recent messages
intact) using the `deepseek-v4-flash` model. If `autoCompact` is false, a
one-line warning is printed instead.

### Sub-agent System (`src/core/agent/subagent.ts`)

`agent_open` lets the main agent delegate a focused research question to one or
more isolated sub-agents.

- **Read-only tool set**: `SUBAGENT_TOOL_NAMES` restricts sub-agents to
  `read_file`, `search_files`, `list_directory`, `code_search`, `web_search`,
  `memory_read`. No `write_file`/`edit_file`/`execute_shell` — sub-agent tool
  calls never go through `confirmOrSkip`.
- **Isolated context**: sub-agents get a fresh `Message[]` array (system + user
  only) — they never see the calling agent's conversation history.
- **Model tier**: downgraded to `deepseek-v4-flash` for DeepSeek models by
  default; pass `noModelDowngrade: true` (or an explicit model) to keep the
  caller's configured model tier.
- **Lifecycle**: single call via `runSubagent()` blocks until a final text
  answer or `MAX_SUBAGENT_ITERATIONS` (10). Each sub-agent has a per-call
  timeout (`DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000`), enforced via an internal
  `AbortController` merged with any caller-supplied `signal`.
- **Concurrent execution**: `runSubagentsConcurrent()` runs multiple
  `SubagentRunOptions` tasks in batches via `Promise.allSettled`, capped at
  `MAX_CONCURRENT_SUBAGENTS` (10). By default a single failed task throws an
  aggregated error; pass `allowPartialFailure: true` to get a mixed
  success/failure result instead.
- **Result caching** (`subagent-cache.ts`): caches results by a sha256 hash of
  `{task, model, systemOverride, cwd}` (opt-in via `useCache: true`), 5-minute
  TTL, 100-entry cap (least-accessed eviction). Managed with
  `/subagent-cache [clear]`.

### Pipeline Engine (`src/core/pipeline/`)

Inspired by Harness CI/CD, each agent interaction is decomposed into **4 stages**
wired in `src/core/agent/generator.ts`, sharing a `PipelineContext`
(`src/core/pipeline/types.ts`):

| Stage | File | Responsibility |
|---|---|---|
| PrepareContext | `prepare-context.ts` | Build system prompt (once per session), inject project guide, init messages |
| StreamResponse | `stream-response.ts` | Stream LLM call, accumulate text/reasoning/tool calls; forwards real cacheHit/cacheMiss tokens via `core/usage.ts` |
| ProcessToolCalls | `process-tools.ts` | Parse tool calls, execute via `executeToolCall()`, inject results |
| PostProcess | `post-process.ts` | Blind-write warnings, token stats, final output; runs R1 thought harvesting |

`process-tools-helpers.ts` is a **helper module, not a stage** — it implements
`executeToolCall()` (confirm flow, `repairToolArgs()` schema-aware JSON repair,
trust-mode state, workspace permission checks, `setTrustMode()` /
`setWorkspacePermissions()`).

### Tool System (`src/core/tools/`)

Eleven built-in tools, registered in `src/core/tools/registry.ts`:

| Tool | File | Destructive? | Notes |
|---|---|---|---|
| `read_file` | `read_file.ts` | No | Optional `start_line`/`end_line` range reading; 100 KB limit; files >100 KB show line count + instructions |
| `write_file` | `write_file.ts` | **Yes** — diff preview + confirm | |
| `edit_file` | `edit_file.ts` | **Yes** — diff preview + confirm | CRLF-tolerant matching (`utils/line-endings.ts`), ambiguity guard |
| `execute_shell` | `execute_shell.ts` | **Yes** — confirm | `timeout_ms` capped at 300 s (5 min); reports captured bytes on timeout |
| `list_directory` | `list_directory.ts` | No | Default 500 entries; `max_entries` param up to 2000 |
| `search_files` | `search_files.ts` | No | `is_regex: boolean` and `include_hidden: boolean` params |
| `memory_write` | `memory.ts` | No | Writes to the agent's persistent memory store |
| `memory_read` | `memory.ts` | No | Reads from the agent's persistent memory store |
| `web_search` | `web_search.ts` | No | Mojeek (default) / SearXNG / DuckDuckGo |
| `code_search` | `code_search.ts` | No | Symbol lookup via `/index` (supports `--semantic`); grep fallback |
| `agent_open` | `agent_open.ts` | No | Delegates a focused research question to isolated sub-agent(s) |

**`registry.ts`** — Tool definitions (name, description, JSON Schema parameters)
mapped to implementations. This is what gets sent to the LLM as available
functions. External callers use `getToolDefinitions()` and `getToolByName()`
only; `getToolRegistry()` is available for MCP tool injection.

**Safety**: destructive tools are gated behind the confirm-dialog / trust-mode /
workspace-permission logic in `process-tools-helpers.ts` (`executeToolCall`).
`src/utils/danger.ts` adds a heuristic second net — dangerous shell commands and
dangerous write paths always force a real prompt, overriding `allow` and
yes-all/auto mode.

### Context Manager (`src/core/context/manager.ts`)

Append-only, cache-first context window management. `checkCapacity()` never
splices messages; it only sets `needsCompact`/`nearCapacity` flags. Soft-trim
fires only from the **end** of the message list (`removeNewestGroup`) and only
when tokens exceed `budget × 2.0` — never the prefix, protecting the DeepSeek
prompt cache. Routine compaction is user-triggered via `/compact` or
auto-compacted in `loop.ts`.

Two budget constants exist in `config.ts`:
- `CONTEXT_BUDGET` = 100_000 (reasoner models)
- `CHAT_CONTEXT_BUDGET` = 90_000 (standard chat models)

**Signals**: `needsCompact` at 70% of budget or >40 non-system messages;
`nearCapacity` (warning) at 95%; emergency soft-trim from the end at 2× budget.

**`project-guide.ts`** — Scans for `CODEGRUNT.md` or `CLAUDE.md` in the working
directory and injects it into the system prompt as codebase-level context.

### Provider System (`src/providers/`)

Providers implement the `LLMProvider` interface defined in `src/types.ts`:

```typescript
interface LLMProvider {
  readonly id: string;
  stream(messages: Message[], options: RequestOptions): AsyncIterable<StreamChunk>;
}
```

`StreamChunk` is a discriminated union: `text_delta`, `reasoning_delta`,
`tool_call_delta`, `finish`. The DeepSeek provider
(`deepseek/provider.ts` + `deepseek/client.ts`) wraps the `openai` npm package
pointed at DeepSeek's API base URL. It handles stream mode with tool call delta
accumulation, reasoning content extraction, token usage tracking via
`src/core/usage.ts`, and **exponential backoff retry** (up to 3 retries on 429,
5xx, or `ECONNRESET`, delays 1 s → 2 s → 4 s).

### Observability (`src/core/observability/`)

- **Logger v2** (`logger.ts`): structured JSONL logs to `~/.codegrunt/logs/`;
  trace IDs via `createLogger('namespace', runId)`; rotation keeps the last 5
  files at max 5 MB each; env: `CODEGRUNT_LOG_LEVEL`,
  `CODEGRUNT_LOG_FILE` (0/false disables file logging), `CODEGRUNT_VERBOSE`.
  Errors auto-published as typed events to the EventBus.
- **Metrics** (`metrics.ts`): lightweight counters, timers, snapshots;
  periodic stderr summaries when `CODEGRUNT_TELEMETRY=1`.
- **Crash reports** (`crash-report.ts`): opt-in (`crashReportOnError` /
  `CODEGRUNT_CRASH_REPORT`) local JSON reports in `~/.codegrunt/crash-reports/`
  for uncaught agent-loop errors. Never includes message history or file
  contents — only truncated task text + error metadata.

**EventBus** (`src/core/events/bus.ts`): typed events — `pipeline:started`,
`pipeline:finished`, `stage:started`, `stage:finished`, `tool:called`,
`tool:result`, `llm:request`, `llm:usage`, `error`.

**Usage tracking** (`src/core/usage.ts`): shared session/per-call token usage
(`addUsage`, `getSessionUsage`, `getLastCallUsage`); extracted from `loop.ts`
to avoid circular imports between provider and pipeline stages.

### Session Persistence & Branching (`src/core/session/`)

- **`store.ts`** — sessions persisted as JSONL at
  `~/.codegrunt/conv-sessions/<id>.json` with an `index.jsonl` for fast
  listing. `/resume [id]` and `/sessions` list/delete; auto-saved after each
  turn; max 20 sessions per working directory.
- **`branching.ts`** — a `BranchTree` persisted per-session at
  `~/.codegrunt/branches/<session-id>.branches.json` records a flat list of
  `Checkpoint`s (turn index, message count, summary) per `Branch`.
  `forkBranch()` creates a new branch at a historical checkpoint;
  `switchToBranch()` returns the message count to restore to;
  `visualizeBranchTree()` renders an ASCII tree. Exposed via `/branch
  <turn-number>`, `/tree`, `/switch <branch-id>`. `recordCheckpoint()` is
  called automatically after each turn in `repl.ts`.

### Memory & Habits (`src/core/memory/`)

- **`store.ts`** — persistent memory entries in
  `~/.codegrunt/memory/entries.jsonl` (fields: `id`, `type`, `name`,
  `description`, `body`, timestamps), filterable by type
  (`user | feedback | project | reference`); per-cwd session summaries in
  `~/.codegrunt/memory/sessions/`.
- **`habits.ts`** — learns user language preference, response verbosity, tool
  confirmation style, and task style from per-turn observations, persisting
  results as `user` memory entries once statistical thresholds are reached.

### Index, Permissions, Snapshots, SWE-bench, MCP, Hooks, LSP

- **`src/core/index/`** — `/index` builds a lightweight symbol index
  (`~/.codegrunt/index/<hash>/index.json`) via grep patterns; `--semantic`
  adds a TF-IDF vector index (`index/embedder.ts`) for meaning-aware fuzzy
  `code_search`.
- **`src/core/permissions/index.ts`** — per-workspace, tool-level
  `allow`/`deny`/`ask` overrides loaded from `.codegrunt/permissions.json`.
  `deny` beats everything (including plan/auto trust mode); `ask` always
  forces a confirm prompt even during yes-for-all. Wired into
  `process-tools-helpers.ts`. Managed with
  `/permissions [set <tool> <action> | reset <tool>]`.
- **`src/core/snapshot/index.ts`** — side-git auto-snapshots in a bare
  `.codegrunt/git` repo on a `snapshots` branch (never touches the user's
  `.git`); created after each coding turn, restorable via `/restore`.
- **`src/core/swebench/export.ts`** — `/swebench <instance-id>` exports
  `git diff HEAD` (staged + unstaged) as a SWE-bench-format JSONL prediction
  line, appended to `swebench_predictions.jsonl`.
- **`src/core/mcp/`** — Model Context Protocol clients (`config.ts`,
  `manager.ts`, `registry.ts`, `types.ts`). Transports: stdio, SSE, and
  Streamable HTTP. Server config persists to `~/.codegrunt/mcp.json`; tools are
  wrapped as `mcp_<server>_<tool>` and injected into `ToolRegistry`. Managed
  with `/mcp add|list|remove|search`.
- **`src/core/hooks/registry.ts`** — user-defined hook scripts in
  `~/.codegrunt/hooks/` at four trigger points (`user-prompt-submit`,
  `pre-tool-use`, `post-tool-use`, `stop`). Fail-open: a broken hook is treated
  as `continue`.
- **`src/core/lsp/checker.ts`** — post-edit diagnostics: TypeScript
  (`tsc --noEmit`), Python (`pyright`), Go (`go vet`), Rust (`cargo check`),
  ESLint, auto-detected by project files.

### Utilities (`src/utils/`)

`billing.ts` (balance/usage + USD/CNY dual currency), `confirm.ts` (diff
preview + confirmation), `constants.ts`, `danger.ts` (heuristic safety net),
`diff-renderer.ts` (colorized unified diff), `display.ts` (Markdown/plan/step/
evaluation rendering), `interrupt.ts` (AbortController for Ctrl+C, dual mode),
`line-endings.ts` (CRLF-tolerant `edit_file` matching), `locale.ts`
(`detectSystemLanguage()`), `markdown.ts` (streaming Markdown renderer),
`pager.ts` (`printPaged()`), `select.ts` (interactive list selector),
`tool-spinner.ts` (animated tool spinner + output preview).

---

## Key Patterns & Conventions

### P/G/E + Intentor Architecture

The agent loop has **four distinct execution paths**:
- `runSkillFlow` — for skill-matched tasks (applies skill system prompt;
  `mode: 'subagent'` runs isolated read-only)
- `runCodingFlow` — for coding tasks (Planner → Generator → Evaluator with
  inner iteration)
- `runChatFlow` — for chat tasks (Generator only, no evaluation)

### Discriminated Union Returns

Several modules (commands, input, tool executor) return tagged unions rather
than throwing. Example from `commands.ts`:
```typescript
type SlashCommandResult =
  | { type: 'handled' }
  | { type: 'clear' }
  | { type: 'config_changed'; config: CodeGruntConfig }
  | { type: 'model_changed'; config: CodeGruntConfig }
  | { type: 'skills_reload' }
  | { type: 'not_a_command' };
```
This keeps control flow at the call site explicit.

### Pipeline Architecture

All generator interaction goes through the Pipeline engine — a sequence of 4
independently testable stages sharing a `PipelineContext`:
```
PrepareContext → StreamResponse → ProcessToolCalls → PostProcess
```

### Config is Passed, Not Global

`CodeGruntConfig` is loaded once in `index.ts` and threaded through function
arguments. Nothing imports config globally. The exception is `config.ts` which
exports constants (`CONTEXT_BUDGET`, `CHAT_CONTEXT_BUDGET`) and predicate
functions (`isReasonerModel`, `supportsReasoning`).

### Provider-Agnostic Agent Loop

The agent loop (`runAgentLoop`) takes an `LLMProvider` interface, not a
concrete DeepSeek instance. Adding a new provider requires only implementing
`LLMProvider` and wiring it into `index.ts`.

### `@`-Reference Resolution Happens Pre-LLM

`resolveAtReferences()` runs on raw user input before messages are constructed.
References are stripped from the visible prompt text and appended as formatted
blocks at the bottom of the message. This means the LLM sees the full content
but the user's prompt remains readable.

### Destructive Operations Require Confirmation

Write/edit/shell tools compute a diff or display the command, call `confirm()`,
and only proceed on explicit "yes". The agent loop has no way to bypass this —
confirmation is inside the tool executor, not the agent. "Yes for all" is
managed via `process-tools-helpers.ts`, and trust mode (`/trust plan|code|auto`)
is a session-level override.

### Model Selection Affects Budget and Behavior

`isReasonerModel()` in `config.ts` checks the model ID. Reasoner models get a
larger context budget and support an `effort` parameter (controlled via
`/reasoning` / `/effort` commands). This distinction flows through context
manager initialization and provider request options.

### Skill Auto-Discovery

The Intentor automatically matches tasks to skills using keyword overlap (≥40%
token match). Skills are also passed to the LLM-based classifier for more
nuanced matching. Matched skills route to `runSkillFlow` which applies the
skill's system prompt override.

### Continuation Detection

Short imperative phrases like "继续", "go on", "next" are detected by the
Intentor and default to the coding path, skipping the Planner.

---

## Slash Commands

All commands below are implemented in `src/cli/commands.ts` (with
`branch-commands.ts` handling `/branch`, `/tree`, `/switch`,
`/subagent-cache`):

| Command | Description |
|---|---|
| `/help` | Show full help message |
| `/init` | Analyze the codebase and generate a `CODEGRUNT.md` project guide |
| `/model [id]` | Switch model interactively or by ID |
| `/config [key] [val]` | View or change config (temperature, maxtokens, topp, frequencypenalty, presencepenalty, reasoning) |
| `/reasoning` / `/effort [low\|medium\|high]` | Set R1 reasoning effort |
| `/theme [dark\|light]` | Set TUI color theme |
| `/token` / `/apikey [key]` | Set / validate the DeepSeek API key |
| `/compact` | Summarize and compress conversation history (hierarchical chunking) |
| `/clear` | Clear conversation context |
| `/review` | Review session changes for logic issues |
| `/cost` | Show session token usage and cost (with cache stats) |
| `/cache` | Show detailed DeepSeek prefix cache hit/miss statistics |
| `/cost-report` | Show aggregated cost report (today / this month) |
| `/status` | Show session status, trust mode, cache hit rate, context size |
| `/balance` | Show account balance & usage (today / this month) |
| `/resume [id]` | Resume a previous conversation session |
| `/sessions [delete <id>]` | List and manage saved sessions |
| `/memory [delete <id>]` | Show persistent memory entries and last session summary |
| `/hooks` | List loaded hook scripts from `~/.codegrunt/hooks/` |
| `/trust [plan\|code\|auto]` | Set trust mode: plan (read-only) / code (confirm) / auto (yes-all) |
| `/restore [hash]` | List and restore a working-tree snapshot |
| `/baseurl [url\|reset]` | Set a custom DeepSeek API base URL |
| `/search-engine [engine]` | Switch web search engine: mojeek / searxng / duckduckgo |
| `/mcp list\|add\|remove\|search` | Manage MCP servers |
| `/index [--semantic]` | Build/update the code symbol index (optional TF-IDF vectors) |
| `/swebench <instance-id>` | Export current session diff as a SWE-bench prediction (JSONL) |
| `/permissions [set <tool> <allow\|deny\|ask> \| reset <tool>]` | View/set per-tool workspace permissions |
| `/branch <turn-number> [label]` | Create a session branch from a historical turn |
| `/tree` | Visualize the session branch tree |
| `/switch <branch-id>` | Switch to a different branch |
| `/subagent-cache [clear]` | Show or clear the sub-agent result cache |

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
| `CODEGRUNT_TRUST_MODE` | Trust mode: `plan` \| `code` \| `auto` | No |
| `CODEGRUNT_SEARCH_ENGINE` | Web search engine: `mojeek` \| `searxng` \| `duckduckgo` | No |
| `CODEGRUNT_SEARXNG_URL` | Self-hosted SearXNG instance URL | No |
| `CODEGRUNT_AUTO_THINKING` | Auto-enable thinking on complex tasks (`1`/`true`) | No |
| `CODEGRUNT_AUTO_COMPACT` | Auto-compact at capacity (`1`/`true`) | No |
| `CODEGRUNT_CRASH_REPORT` | Write local crash reports (`1`/`true`) | No |
| `CODEGRUNT_THEME` | TUI theme: `dark` \| `light` | No |
| `CODEGRUNT_LOG_LEVEL` | Log level: `debug` \| `info` \| `warn` \| `error` | No |
| `CODEGRUNT_LOG_FILE` | Set to `0` or `false` to disable file logging | No |
| `CODEGRUNT_VERBOSE` | Enable verbose stderr output | No |
| `CODEGRUNT_TELEMETRY` | Set to `1` for periodic metrics summaries | No |
| `CODEGRUNT_HIDE_TOOL_OUTPUT` | Set to `1` to suppress tool output previews | No |

### Config File

`~/.codegrunt/config.json` — created by the setup wizard on first run. Stores:
```json
{
  "apiKey": "sk-...",
  "model": "deepseek-v4-pro",
  "provider": "deepseek",
  "baseURL": "https://api.deepseek.com",
  "maxTokens": 8192,
  "temperature": 0.2,
  "reasoningEffort": "medium",
  "topP": 1,
  "frequencyPenalty": 0,
  "presencePenalty": 0,
  "trustMode": "code",
  "searchEngine": "mojeek",
  "autoThinkingMode": true,
  "autoCompact": true,
  "crashReportOnError": false,
  "theme": "dark"
}
```

### Project Guide Files

At startup, the context manager scans the working directory for `CODEGRUNT.md`
(preferred) or `CLAUDE.md` (fallback). If found, the file content is prepended
to the system prompt to give the LLM project-specific context.

### Skills Directory

`.codegrunt/skills/` (project) > `.claude/skills/` (Claude Code-compatible) >
`~/.codegrunt/skills/` (global) — each skill is a `.md` file or a directory
with YAML frontmatter (`name`, `description`, `system`, `mode`) and a Markdown
body. Install new skills via `codegrunt skills add -f <file.zip>` or create
them with `/skills create <name>`. Skills appear as slash commands in the REPL
and are auto-discovered by the Intentor.

### Log Files

Structured JSONL logs are written to `~/.codegrunt/logs/` by default. Log
rotation keeps the last 5 files (max 5 MB each). File logging can be disabled
via `CODEGRUNT_LOG_FILE=0`.
