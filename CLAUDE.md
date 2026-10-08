# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # dev mode with watch (tsx)
npm run build      # compile TypeScript to dist/
npm run typecheck  # type check only, no emit (noUnusedLocals is on)
npm run lint       # eslint (src + tests)
npm test           # run vitest test suite
npm start          # run compiled dist/cli/index.js

# Run a single test file
npx vitest run tests/tools/read-file.test.ts
```

## Architecture

CodeGrunt is a terminal-native agentic coding assistant using a **P/G/E (Planner / Generator / Evaluator) + Intentor** architecture powered by a Harness-style pipeline engine.

- `src/cli/` — entry point, REPL loop, argument parsing, slash commands (`commands/` — a Command registry, see below), branch commands (`branch-commands.ts`), skills, @-reference resolver, **Ink/React terminal UI** (persistent `App.tsx` tree + `PromptInput`, `StatusBar`, `output-channel` sink, etc.)
- `src/core/agent/` — Intentor (intent + skill classification), Planner (task decomposition), Generator (`generator.ts` — shared 4-stage pipeline runner), Evaluator (quality check + auto-refine), complexity router (`complexity.ts` — request classifier + thinking-mode router), Subagent (`subagent.ts` — isolated sub-task execution, sync + concurrent; `subagent-runtime.ts` — its types, per-turn context and the runner seam `agent_open` calls through; `subagent-cache.ts` — result cache by input hash), `step-runner.ts` (one plan step: generate → evaluate → refine, shared by the coding flow and the orchestrator), `tool-loop.ts` (the iterative tool loop shared by the chat and skill flows), **Orchestrator** (`orchestrator.ts` — merges consecutive `parallelizable` steps into batches and dispatches them to workers), **Worker** (`worker.ts` — a `runSubagent` variant granted `write_file`/`edit_file`), R1 Thought Harvester (`r1-harvester.ts` — recovers tool calls escaped into `reasoning_content`)
- `src/core/pipeline/` — Harness-style pipeline engine (4 stages: prepare context → stream response → process tools → post-process) sharing a `PipelineContext`. Tool execution is split out of the stages: `core/tools/tool-executor.ts` (`executeToolCall`), `core/tools/args-repair.ts` (JSON/schema repair), and `core/policy/` (`state.ts` trust mode + yes-for-all + workspace permissions, `gates.ts` required-params → workspace deny → plan mode, `confirm.ts` per-tool confirm strategies)
- `src/core/tools/` — 11 built-in tools: file read/write/edit, shell execution, directory listing, search, memory read/write (`memory.ts`), web search, code search, `agent_open` (sub-agent delegation). `ToolRegistry` manages registration internally
  - Shared infrastructure (ported from the `pi` project): `truncate.ts` (head/tail truncation by line + byte limit, never splits a line), `path-utils.ts` (`resolveToCwd`: `~` expansion, leading `@` stripped, unicode spaces), `file-mutation-queue.ts` (per-file serialization of write/edit), `output-accumulator.ts` (bounded shell output, spills to a temp file), `edit-diff.ts` (shared edit matcher). `Tool.execute(args, ctx?)` takes an optional `ToolContext` (`signal`, `cwd`) that `executeToolCall` fills from the turn's abort signal and cwd
  - `read_file`: `start_line`/`end_line` (either may be given alone); streams, so large files are never loaded whole. Output is capped at 2000 lines / 100KB and ends with the exact `start_line` to continue from
  - `write_file`: serialized per file; still re-checks the confirm-time snapshot (`_originalContent`) before overwriting
  - `edit_file`: single `old_string`/`new_string` replacement. Matching order is exact, then CRLF/LF-tolerant, then fuzzy (trailing whitespace, smart quotes, unicode dashes/spaces; reported in the result). `applyEdit()` in `confirm.ts` uses the same matcher so the diff shown for confirmation is what gets written. Empty `old_string` is rejected
  - `execute_shell`: `timeout_ms` capped at 300s (5 min). Output keeps the last 2000 lines / 50KB; when cut, the full output is saved to a temp file and its path is reported. Timeout and Ctrl+C/Esc kill the whole process tree (`taskkill /T` on Windows, process group elsewhere)
  - `search_files`: `is_regex`, `include_hidden`, `ignore_case`, `limit` (default 50, max 500); matching lines are cut at 500 chars
  - `list_directory`: nested tree (directories first, case-insensitive), `depth`, `max_entries` (default 500, max 2000); missing path is an error, not "empty directory"
  - `agent_open`: delegates a focused research question to an isolated sub-agent (see Subagent section below)
- `src/core/context/` — append-only, cache-first context window management (token budget, soft-trim-from-end on emergency overflow only) and project guide loading
- `src/core/session/` — session persistence (`store.ts` — JSONL at `~/.codegrunt/conv-sessions/`) and session branching (`branching.ts` — fork/switch/tree over per-turn checkpoints)
- `src/core/events/` — typed EventBus for pipeline/tool/LLM lifecycle events (`bus.ts`)
- `src/core/observability/` — structured Logger (v2: file transport, trace IDs, log rotation) + lightweight Metrics (counters, timers, snapshots) + opt-in local crash reports (`crash-report.ts`)
- `src/core/memory/` — persistent memory store (`store.ts`) + habit learning (`habits.ts`)
- `src/core/permissions/` — per-workspace tool permission overrides (`permissions.json`)
- `src/core/snapshot/` — side-git auto-snapshots
- `src/core/hooks/` — user-defined hook scripts
- `src/core/lsp/` — post-edit language diagnostics
- `src/core/mcp/` — Model Context Protocol clients (stdio / SSE / Streamable HTTP)
- `src/core/index/` — code symbol index (+ TF-IDF semantic vectors via `embedder.ts`)
- `src/core/swebench/` — SWE-bench prediction export
- `src/core/usage.ts` — shared session/per-call token usage tracking (`addUsage`, `getSessionUsage`, `getLastCallUsage`); extracted from `loop.ts` to avoid circular imports between provider and pipeline stages
- `src/providers/` — LLM provider adapters implementing a shared `LLMProvider` interface; includes exponential backoff retry (3 attempts, 1s→2s→4s) for 429/5xx errors
- `src/utils/` — shared utilities (display, confirm, billing, markdown rendering, interrupt, interactive selector)

## Agent Loop (`src/core/agent/loop.ts`)

**Phase 0 — Intentor**: Classifies tasks as coding (→ P/G/E), chat (→ direct gen), or skill match (→ `runSkillFlow`). Uses fast heuristics first; falls back to LLM only when ambiguous. Supports:
- Continuation detection: short imperative phrases (e.g. "继续", "go on") default to coding path
- Skill routing: heuristic keyword overlap + LLM-based matching, routes to skill flow

**Coding Flow — P/G/E**:
1. **Planner**: Decomposes complex tasks into 2-5 steps. Skipped for short tasks (≤50 chars) and continuations. Injects real tool list into prompt and filters invalid `toolsHint` values
2. **Generator**: Pipeline engine executes each step — with **inner iteration** (multi-turn tool calls per step, not just 1 turn)
3. **Evaluator**: Quality check + auto-refine (max 3 retries, then prompts user whether to continue). Matches 14 error patterns; after write/edit, runs `src/core/lsp/checker.ts` diagnostics (tsc/pyright/go vet/cargo check/eslint, auto-detected by project files). `pruneRefineMessages` cleans eval feedback between steps
4. `sessionHasRead` tracking prevents redundant file reads across turns
5. **Parallel orchestration** (`orchestrator.ts`): when the Planner marks any step `parallelizable`, `runCodingFlow` hands the plan to `runOrchestrator()` instead of the sequential loop. `groupIntoBatches()` merges each run of consecutive parallelizable steps into one batch, demoting a step to its own serial batch when its `targetFiles` overlap with an earlier step in the run (or when it declares none), so two workers never race on the same file. Parallel batches are dispatched to `worker.ts` sub-agents (`runSubagentsConcurrent`, `allowPartialFailure: true`); their summaries are injected back into the main context as a `user` message, then any failed step is retried serially through `runSingleStep()`. An `orchestrator:batch` event is emitted per batch. Plans with no parallelizable step take the original sequential path untouched.

**Chat Flow**: Skips Planner/Evaluator, uses Generator pipeline iteratively (up to 30 iterations). Prints fallback text if model returns empty.

**Skill Flow**: Applies skill system prompt + content, then chat-style generation with tool call iteration.

**System prompt stability**: Built once per session, never mutated (maximizes DeepSeek prompt cache hits). For R1 reasoner models, the system prompt is embedded in the first user message.

**Model branching**: `isReasonerModel()` detects R1 variants; `supportsReasoning()` matches V4/Pro models that emit `reasoning_content`. Context budgets: 100k tokens for reasoning models, 90k for chat models. `reasoning_content` is only sent back for the last assistant message (not full history) to reduce token cost.

**Model auto-routing** (`selectModelForTask`): for `deepseek-v4-*` models only. Non-coding/skill tasks and simple/≤60-char tasks route to `deepseek-v4-flash`; complex-coding signals route to `deepseek-v4-pro`; never routes to a reasoner model.

**Thinking-mode router** (`src/core/agent/complexity.ts`): `classifyComplexity(task)` returns a `simple | medium | complex` tier. For code tasks: simple → force `thinking: 'disabled'`; complex → force `thinking: 'enabled'` when `config.autoThinkingMode` (default true); medium → untouched.

**Context compaction**: the append-only `ContextManager` sets `needsCompact` at 70% of token budget or >40 non-system messages (warning at 95%; emergency soft-trim from the **end** only at 2× budget — never the prefix, protecting the prompt cache). `/compact` and auto-compact use hierarchical chunk summarization via `compact.ts`: keeps 15 recent messages intact, per-chunk summary ≤400 tokens, merged final summary ≤1500 tokens, run on the `deepseek-v4-flash` model.

## Sub-agent Execution (`src/core/agent/subagent.ts`)

`agent_open` lets the main agent delegate a focused research question to one or more isolated sub-agents. A single call via `runSubagent()` blocks until that sub-agent produces a final text answer or hits `MAX_SUBAGENT_ITERATIONS` (10).

- **Read-only tool set**: `getSubagentToolNames()` returns every tool declaring `meta.subagentSafe` (`read_file`, `search_files`, `list_directory`, `code_search`, `web_search`, `memory_read`). No `write_file`/`edit_file`/`execute_shell` — this sidesteps the confirm-dialog stdin/stdout contention that concurrent sub-agents running destructive tools would create, and means sub-agent tool calls never go through `confirmOrSkip`.
- **Isolated context**: sub-agents get a fresh `Message[]` array (system + user only) — they never see the calling agent's conversation history.
- **Model tier**: downgraded to `deepseek-v4-flash` for DeepSeek models by default (same policy as Intentor classification calls); pass `noModelDowngrade: true` to keep the caller's configured model tier.
- **Wiring**: `setSubagentContext(provider, model)` is called once per turn in `runAgentLoop` (and again after model auto-routing) so the `agent_open` tool — which only receives `args: Record<string, unknown>`, not the provider — can reach the LLM. Mirrors the `setTrustMode()` module-level-state pattern in `core/policy/state.ts`.
- **Concurrent execution (v0.7)**: `runSubagentsConcurrent()` runs multiple `SubagentRunOptions` tasks in batches via `Promise.allSettled`, capped at `MAX_CONCURRENT_SUBAGENTS` (10) regardless of the requested `concurrency` value. By default a single failed task throws with an aggregated error message; pass `allowPartialFailure: true` to get a mixed success/failure `ConcurrentSubagentResult` instead.
- **Lifecycle management**: each sub-agent has a per-call timeout (`timeoutMs`, default 120s) enforced via an internal `AbortController`; `combineAbortSignals()` merges that timeout signal with any caller-supplied `signal` so external cancellation (e.g. Ctrl+C) and timeout share one abort path.
- **Result caching**: `src/core/agent/subagent-cache.ts` caches results by a sha256 hash of `{task, model, systemOverride, cwd}` (opt-in via `useCache: true`), with a 5-minute TTL and a 100-entry cap (least-accessed entry evicted first). Managed with `/subagent-cache [clear]`.

## Code organization

Dependencies point one way: `src/cli` → `src/core` → `src/providers`/`src/utils`. `src/core` never imports from `src/cli` (output goes through `core/output/output-channel.ts`), and `madge --circular` reports no cycles — keep it that way.

Patterns used, and where to extend them:

- **Command registry** (`src/cli/commands/`): a slash command is `{ name, aliases?, desc, run(ctx) }`; add one by registering it in a domain file and adding its name to the display-order list in `index.ts` (a test fails if the two drift). `/resume` is listed but handled by `repl.ts`.
- **Tool traits** (`Tool.meta`): declare `readsFiles` / `writesFiles` / `destructive` / `subagentSafe` on the tool instead of adding names to lists. Required parameters come from the tool's own schema.
- **Confirm strategies** (`core/policy/confirm.ts`): a destructive tool gets a prompt by registering a strategy under its name. Gates run in order: required params → workspace deny → plan mode.
- **Search engines** (`core/tools/web-search/engines/`): implement `SearchEngine` and add it to the engine map.
- **Model policy** (`providers/model-policy.ts`): all "is this a DeepSeek / reasoner / which cheap model" decisions live here.
- **Directory-skip presets** (`utils/fs-ignore.ts`): the presets differ on purpose; pick the one matching the walker.

Characterization tests pin current behavior, quirks included (see `KNOWN QUIRK` in `tests/agent/`); fix a quirk in its own change, not while refactoring.

## Provider System

New LLM backends implement the `LLMProvider` interface defined in `src/types.ts`:

```typescript
interface LLMProvider {
  readonly id: string;
  stream(messages: Message[], options: RequestOptions): AsyncIterable<StreamChunk>;
}
```

`StreamChunk` is a discriminated union: `text_delta`, `reasoning_delta`, `tool_call_delta`, `finish`. The DeepSeek provider (`src/providers/deepseek/`) wraps the `openai` npm package pointed at DeepSeek's API base URL. Retries automatically on 429/5xx with exponential backoff (1s → 2s → 4s, max 3 attempts).

## Pipeline Engine (`src/core/pipeline/`)

Inspired by Harness CI/CD, each agent interaction is decomposed into **4 stages** (wired in `src/core/agent/generator.ts`) sharing a `PipelineContext`:

| Stage | Responsibility |
|---|---|
| PrepareContext | Build system prompt, inject project guide, init messages |
| StreamResponse | Stream LLM call, accumulate text/reasoning/tool calls; emits real cacheHitTokens/cacheMissTokens via `core/usage.ts` |
| ProcessToolCalls | Parse tool calls, execute via executor, inject results |
| PostProcess | Blind-write warnings, token stats, final output |

`executeToolCall()` lives in `core/tools/tool-executor.ts`, not in a stage: it repairs arguments (`args-repair.ts`), runs the policy gates (`core/policy/gates.ts`), asks the tool's confirm strategy (`core/policy/confirm.ts`) and executes. Tools declare traits in `Tool.meta` (`readsFiles`, `writesFiles`, `destructive`, `subagentSafe`); the registry answers trait queries (`toolHasTrait`, `toolNamesWithTrait`), so there are no per-feature tool-name lists. Required parameters come from each tool's own schema.

## Tool Confirmation Flow

Destructive tools (`write_file`, `edit_file`, `execute_shell`) are handled by the confirm strategies in `src/core/policy/confirm.ts` (registered per tool name), which call `confirmEdit()` / `confirmShellCommand()` in `src/utils/confirm.ts` to show a diff and prompt the user. Choosing "Yes for all" sets a session-level flag. On user rejection, the assistant message `tool_calls` array is trimmed to only the processed calls. `resetYesAll()` is called at the start of each new user turn.

## Skills System

Skills are Markdown files with YAML frontmatter (`name`, `description`, `system`, `mode: inline|subagent`, and body content). They are loaded from `<cwd>/.codegrunt/skills/` (project) and `.claude/skills/` (Claude Code-compatible, project) and `~/.codegrunt/skills/` (global), with priority `.codegrunt/skills/` > `.claude/skills/` > global. Installed from `.zip` archives via `codegrunt skills add -f <file.zip>` (or created with `/skills create <name>`). A skill can define a `system` field to completely replace the default coding-assistant identity. Skills are auto-discovered by the Intentor via keyword overlap matching.

## UI / Input

**Ink/React components** (`src/cli/ink/`): a persistent React tree (`App.tsx`) owns the terminal for the whole REPL session — `<Static>` history, live tool line, streaming text, `<StatusBar>` (`model · ⎇ branch · Nk tokens`; `{elapsed}s · Esc to cancel` while busy), plus `<PromptInput>`/`<ListPicker>`. Supporting modules:
- `src/core/output/output-channel.ts` (lives in core so the agent never imports from `cli/`) — output routing seam: no sink (one-shot) → straight to `process.stdout`; sink registered (REPL) → routed into Ink state (`write`, `appendLiveText`, `setLiveTextDirect`, `commitLiveText`, `discardLiveText`, `setLiveTool`) + a picker registry so `select.ts` pickers render inside the App tree
- `PromptInput.tsx` — main input, framed by two full-width `─` rules instead of a `> ` prompt (rule color = state: accent idle, purple in a skill, grey while busy; an active skill name and `↑ N more` / `↓ N more` scroll counts sit inside the rules; visible height is capped at ~30% of the terminal). Cursor, history navigation, autocomplete dropdown, busy mode, Ctrl+C double-press cancel, bracketed paste. Editing keys: Ctrl+J newline (plus backslash-continuation), Ctrl+A/E line start/end, Ctrl+W / Alt+Backspace delete word, Ctrl+U / Ctrl+K delete to line start/end, Alt/Ctrl+←/→ and Alt+b/f word jumps. ↑/↓ move between lines of a multi-line entry first and only recall history from the first/last line
- `editing.ts` — pure helpers behind those keys (line/word movement, deletions, scroll window, `buildRule`); `useTerminalSize.ts` — columns/rows that follow `resize`
- `Dropdown.tsx` — autocomplete overlay with an aligned description column; ↑/↓ wrap around. `ListPicker.tsx` — arrow-key selector for model/config selection
- `StatusBar` renders as a footer below the input
- `useAutocomplete.ts` — file/slash/skill completion; `useHistory.ts` — persistent command history
- `git-branch.ts` — cached current git branch; `paste.ts` — bracketed-paste state machine

**Theme**: The accent color throughout is `#4A90D9` (dark theme) / `#1D5D96` (light theme) — see `src/utils/constants.ts` (`ACCENT`, `applyTheme`, `muted`). Both the inline dropdown and `selectFromList` use `❯` as the selected-item indicator. `/theme` switches between `dark` (default) and `light`.

## Logger v2 (`src/core/observability/logger.ts`)

- **File transport**: Structured JSONL logs written to `~/.codegrunt/logs/`
- **Trace IDs**: `runId` propagated through `createLogger()` for cross-session correlation
- **Log rotation**: Max 5 files, 5 MB each
- **Environment**: `CODEGRUNT_LOG_LEVEL` (debug/info/warn/error), `CODEGRUNT_LOG_FILE` (0/1 to disable), `CODEGRUNT_VERBOSE`
- **EventBus integration**: Errors auto-published as typed events

## Configuration

Runtime config via env vars or `~/.codegrunt/config.json`:

- `DEEPSEEK_API_KEY` — required for the default DeepSeek provider
- `CODEGRUNT_MODEL` — model ID (default: `deepseek-v4-pro`)
- `CODEGRUNT_PROVIDER` — provider ID (default: `deepseek`)
- `CODEGRUNT_MAX_TOKENS` — max tokens per response (default: `8192`)
- `CODEGRUNT_TEMPERATURE` — response temperature (default: `0.2`)
- `CODEGRUNT_BASE_URL` — API base URL (default: `https://api.deepseek.com`)
- `CODEGRUNT_REASONING_EFFORT` — R1 reasoning effort: `low` | `medium` | `high`
- `CODEGRUNT_TOP_P` — nucleus sampling (default: `1`)
- `CODEGRUNT_FREQUENCY_PENALTY` — repetition penalty (default: `0`)
- `CODEGRUNT_PRESENCE_PENALTY` — topic diversity penalty (default: `0`)
- `CODEGRUNT_TRUST_MODE` — trust mode: `plan` | `code` | `auto` (default: `code`)
- `CODEGRUNT_SEARCH_ENGINE` — web search engine: `mojeek` | `searxng` | `duckduckgo` (default: `mojeek`)
- `CODEGRUNT_SEARXNG_URL` — self-hosted SearXNG instance URL
- `CODEGRUNT_AUTO_THINKING` — auto-enable thinking on complex tasks (default: `true`)
- `CODEGRUNT_AUTO_COMPACT` — auto-compact at capacity (default: `true`)
- `CODEGRUNT_CRASH_REPORT` — write local crash reports (default: `false`)
- `CODEGRUNT_THEME` — TUI theme: `dark` | `light` (default: `dark`)
- `CODEGRUNT_TELEMETRY` — set to `1` for periodic metrics summaries
- `CODEGRUNT_HIDE_TOOL_OUTPUT` — set to `1` to suppress tool output previews

Config file is created on first run via the setup wizard (`src/cli/setup.ts`). Env vars take precedence over the config file.

## v0.5 additions (workspace permissions, SWE-bench export, Skills v2, Evaluator v2)

Shipped in v0.1.3 — see `Docs/development-guide.md` roadmap for full context. Summary:

- **`src/core/permissions/index.ts`** — per-workspace, tool-level `allow`/`deny`/`ask` overrides loaded from `.codegrunt/permissions.json`. `deny` takes precedence over everything (including plan/auto trust mode); `ask` always forces a confirm prompt even during session-level yes-for-all. Wired in through `core/policy/state.ts` (`setWorkspacePermissions()`) and `getToolPermission()` in `tool-executor.ts`. Managed with `/permissions [set <tool> <action> | reset <tool>]`.
- **`src/core/swebench/export.ts`** — `/swebench <instance-id>` exports `git diff HEAD` (staged + unstaged) as a SWE-bench-format JSONL line (`{instance_id, model_patch, model_name_or_path}`), appended to `swebench_predictions.jsonl`. Does not reuse the Side-git snapshot repo — that one tracks per-turn commits on a separate branch, not a single cumulative diff.
- **Skills `mode: subagent`** (`src/cli/skills.ts`) — a skill can set `mode: subagent` in frontmatter to route through the isolated read-only `runSubagent()` loop instead of the main chat loop (no shared history, no write/edit/shell tools). Project skills are now also read from `.claude/skills/` (Claude Code compatible), with priority `.codegrunt/skills/` > `.claude/skills/` > `~/.codegrunt/skills/`.
- **Evaluator v2** — diagnostics logic extracted from `evaluator.ts` into `src/core/lsp/checker.ts` (`runDiagnostics()`/`formatDiagnostics()`), now covering TypeScript/Python/Go/Rust **and ESLint** (new). Evaluation itself remains pure structural checks (no LLM call) — see rationale comment at the top of `evaluator.ts`.

## v0.6 additions (cache-first ContextManager, Schema-aware repair, R1 harvesting)

Roadmap target: 缓存极致 + 成本透明 (see `docs/development-guide.md`). Summary:

- **Append-only `ContextManager`** (`src/core/context/manager.ts`) — `checkCapacity()` no longer proactively splices messages to stay under budget; it only sets `needsCompact`/`nearCapacity` flags. Emergency trimming (`softTrimFromEnd()`) fires only once token count exceeds `budget × 2.0`, and trims from the **end** of the message list, never the prefix — this protects the DeepSeek prompt cache. Routine compaction runs via `/compact` or auto-compact wired into `loop.ts` (`compact.ts` hierarchical chunk summarization on the flash model).
- **`/cache` command** (`src/cli/commands/usage.ts`) — `printCacheStats()` reports cache hit rate and estimated savings from `getSessionUsage()`.
- **`/cost-report` command** — `printCostReport()` shows today/this-month usage with cache-derived savings estimate.
- **`/effort` (`/reasoning`) command** — `switchReasoningEffort()` toggles R1 reasoning effort between low/medium/high per turn.
- **Schema-aware tool-call repair** — `repairToolArgs(argsJson, toolName)` in `src/core/tools/args-repair.ts` now takes the tool name so repair can validate against that tool's expected parameter names/types, not just fix JSON syntax.
- **R1 Thought Harvesting** (`src/core/agent/r1-harvester.ts`) — `harvestToolCalls()` scans `reasoning_content` for patterns like `tool_name({...})` that R1 "thought about" but never emitted as a formal tool call; `filterNonEscaped()` excludes any that were already issued for real, `deduplicateHarvested()` collapses duplicates by (tool, first-arg) key. Wired into `post-process.ts`, triggered only when the model produced no formal tool calls and no text output. Covered by `tests/agent/r1-harvester.test.ts` (12 cases).

## v0.7 additions (concurrent sub-agents, session branching)

Roadmap target: 并发编排 + 会话分支 (see `docs/development-guide.md`). Summary:

- **Concurrent sub-agents** — see the "Concurrent execution (v0.7)" and "Lifecycle management" bullets in the Sub-agent Execution section above (`runSubagentsConcurrent()`, `subagent-cache.ts`).
- **Session branching** (`src/core/session/branching.ts` + `src/cli/branch-commands.ts`) — a `BranchTree` persisted per-session at `~/.codegrunt/branches/<session-id>.branches.json` records a flat list of `Checkpoint`s (turn index, message count, summary) per `Branch`. `forkBranch()` creates a new branch pointing at a historical checkpoint on an existing branch; `switchToBranch()` returns the message count to restore to; `visualizeBranchTree()` renders an ASCII tree. Exposed via `/branch <turn-number>`, `/tree`, `/switch <branch-id>` (registered in `src/cli/commands/`). `recordCheckpoint()` is called automatically after each turn in `src/cli/repl/`. Covered by `tests/core/branching.test.ts` (21 cases).

## v0.8 additions (persistent Ink TUI, themes, thinking routing, auto-compact, crash reports)

Roadmap target: see `docs/development-guide.md`. Summary:

- **Persistent Ink/React TUI** — the REPL now mounts a single persistent React tree (`src/cli/ink/App.tsx`) for the whole session; `output-channel.ts` routes all terminal output through it once a sink is registered (one-shot mode still writes straight to stdout). `StatusBar` shows `model · ⎇ branch · Nk tokens` and a busy readout. Pickers (`/model`, `/resume`, ...) render inside the App tree via the picker registry.
- **`/theme` command** (`dark` default / `light`) — `applyTheme()` in `src/utils/constants.ts` swaps `ACCENT` (`#4A90D9` ↔ `#1D5D96`) and muted color. Semantic colors (red/green/yellow) are intentionally not theme-controlled.
- **Auto thinking mode** (`complexity.ts` router) — `config.autoThinkingMode` (default true): complex coding tasks force `thinking: 'enabled'`, simple tasks force `thinking: 'disabled'`; medium untouched.
- **Auto-compact** — `maybeAutoCompact()` in `loop.ts` runs at the start of each turn when `context.needsCompact` (70% budget / 40+ messages) and `config.autoCompact` (default true), using the hierarchical chunk summarizer in `compact.ts` on the flash model.
- **Local crash reports** (`src/core/observability/crash-report.ts`) — opt-in (`crashReportOnError` / `CODEGRUNT_CRASH_REPORT`): JSON reports written to `~/.codegrunt/crash-reports/` on uncaught agent-loop errors (never message history or file contents).
- **Session store at `~/.codegrunt/conv-sessions/`** — `/resume`, `/sessions`, `--resume` persist/restore full message histories (max 20 sessions per cwd).
- **Semantic code index** (`src/core/index/embedder.ts`) — `/index --semantic` builds a TF-IDF vector index for fuzzy `code_search`.

## v0.9 additions (parallel orchestration, module split, engineering hygiene)

Summary:

- **Orchestrator / Worker** (`src/core/agent/orchestrator.ts`, `worker.ts`) — consecutive plan steps the Planner marked `parallelizable: true` (with non-overlapping `targetFiles`) are merged into one batch and run concurrently as write-capable sub-agents; overlapping or unannotated steps stay serial. See the "Parallel orchestration" bullet in the Agent Loop section.
- **Shared step logic extracted** — `step-runner.ts` (`runSingleStep`, `pruneRefineMessages`, `createStepRunState`) and `tool-loop.ts` are now used by both the sequential coding flow and the orchestrator, so the per-step generate → evaluate → refine loop exists in exactly one place.
- **CLI module split** — the 1512-line `src/cli/commands.ts` became a `src/cli/commands/` package (one file per command domain + a `registry.ts` command registry with a display-order list that a test pins), `init.ts` became `src/cli/init/` (`index.ts`/`prompt.ts`/`scan.ts`), and `repl.ts` gained a `src/cli/repl/` sibling (`apply-config.ts`, `resume.ts`, `session-recorder.ts`).
- **Core extraction** — tool policy moved to `src/core/policy/` (`state.ts` trust mode + yes-for-all + workspace permissions, `gates.ts` required-params → workspace-deny → plan-mode, `confirm.ts` per-tool confirm strategies); `executeToolCall` moved out of the pipeline stages into `src/core/tools/tool-executor.ts`; the output sink moved to `src/core/output/output-channel.ts` so `src/core` never imports `src/cli`; shared tool infrastructure (`truncate.ts`, `path-utils.ts`, `args-repair.ts`, `edit-diff.ts`, `file-mutation-queue.ts`, `output-accumulator.ts`) sits beside the tools, and web-search engines were split into `src/core/tools/web-search/engines/`.
- **Engineering hygiene** — `eslint.config.js` + `.prettierrc.json` with `npm run lint` / `npm run format:check`; `tsconfig.json` turns on `noUnusedLocals`; `LICENSE` and `CONTRIBUTING.md` added.

## Known Issues & Technical Debt

### Test coverage gaps

Still not tested: the 4 pipeline stages individually (`prepare-context`, `stream-response`, `process-tools`, `post-process` — only the integrated `tests/integration/pipeline-e2e.test.ts` and `tests/pipeline/engine.test.ts` exist), `compact.ts` chunking logic, `at-resolver.ts`, `skills.ts` zip install, `lsp/checker.ts` diagnostics.

An Ink component-level test harness now exists (`ink-testing-library`), covering `App`, `PromptInput`, `ListPicker`, `StatusBar`, `output-channel`, `paste`, `git-branch`, `useHistory`, plus `editing.ts` (pure key-handling helpers) and `init/scan.ts`. The flow layer is covered by `tests/agent/` (`chat-flow`, `coding-flow`, `skill-flow`, `orchestrator`, `worker`, backed by the `_flow-harness.ts` fake-provider harness) and the command layer by `tests/cli/command-registry.test.ts` (registry ↔ display-order drift) + `commands-dispatch.test.ts`. Still thin: the `useAutocomplete` ↔ `PromptInput` history-vs-dropdown interaction beyond the pure-function unit tests in `tests/cli/useAutocomplete.test.ts`.

---

## Priority Work Items

### P0 — Correctness bugs ✅ Done

1. ~~**Fix `systemPromptOverride` in `PrepareContextStage`**~~ — done
2. ~~**Fix `edit_file` multi-occurrence behavior**~~ — done

### P1 — Core feature completeness ✅ Done

3. ~~**Wire auto-compact into `ContextManager`**~~ — done: triggers at 70% budget (raised from 50% to protect prefix cache) or >40 messages
4. ~~**Remove `executor.ts` dead code**~~ — done: file deleted
5. ~~**De-duplicate `detectSystemLanguage()`**~~ — done: extracted to `src/utils/locale.ts`

### P2 — Test coverage ✅ Done

6. ~~**`edit_file` unit tests**~~ — done
7. ~~**`ContextManager` tests**~~ — done
8. ~~**`Intentor` + `Planner` tests**~~ — done
9. ~~**Pipeline stage integration test**~~ — done
10. ~~**`permissions/index.ts` unit tests**~~ — done: load/save/get/set/reset, malformed JSON, invalid shape
11. ~~**`swebench/export.ts` unit tests**~~ — done: real git fixture, staged/unstaged diff, JSONL append, custom output path, non-git error

### P3 — Cleanup ✅ Done

12. ~~Remove dead code: `classifier.ts`, `showSlashCommandSelector` stub, `ServiceContainer`/DI system~~ — done: all deleted
13. ~~Emit `ConversationTrimmedEvent`~~ — removed from EventBus along with other unused event types
14. ~~Remove unused `ignore` dependency from `package.json`~~ — done (v0.1.3)

### P4 — v0.6/v0.7 test coverage + UI input fixes ✅ Done

15. ~~**`subagent-cache.ts` unit tests**~~ — done: hashKey stability/uniqueness, get/set/has, TTL expiry (fake timers), LRU-by-access eviction at 100-entry cap, clear, stats
16. ~~**`branching.ts` unit tests**~~ — done: load/save round-trip, recordCheckpoint (including truncation + dangling-branch fallback), forkBranch (+ invalid turn index / missing source), switchToBranch, getCurrentBranchId (most-recent-checkpoint resolution), deleteBranch (+ descendants, root-protection), getCheckpoint, visualizeBranchTree
17. ~~**`subagent.ts` concurrency/timeout/partial-failure unit tests**~~ — done: `runSubagentsConcurrent` ordering, concurrency-limit enforcement (including the hard 10-task cap), aggregated-throw vs `allowPartialFailure`, shared abort signal propagation; `runSubagent` timeout and cache-hit/cache-miss-by-task paths
18. ~~**Fixed history navigation getting stuck in slash-command dropdown**~~ — `PromptInput.tsx` now suppresses the autocomplete dropdown right after an ↑/↓ history recall (`suppressDropdown`), so a recalled `/foo` line doesn't hijack the next history navigation. Suppression clears on the next non-arrow keystroke.
19. ~~**Fixed `@` file references only working at input start, and only once**~~ — `findAtTokenAtCursor()` in `useAutocomplete.ts` now finds the whitespace-delimited `@token` under the cursor (not just a whole-input-starts-with-`@` check), and `acceptSelection()` in `PromptInput.tsx` replaces only that token's span rather than the entire input line, so multiple `@refs` can coexist anywhere in the message. Covered by `tests/cli/useAutocomplete.test.ts`.
