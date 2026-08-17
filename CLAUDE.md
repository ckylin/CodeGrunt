# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # dev mode with watch (tsx)
npm run build      # compile TypeScript to dist/
npm run typecheck  # type check only, no emit
npm test           # run vitest test suite
npm start          # run compiled dist/cli/index.js

# Run a single test file
npx vitest run tests/tools/read_file.test.ts
```

## Architecture

CodeGrunt is a terminal-native agentic coding assistant using a **P/G/E (Planner / Generator / Evaluator) + Intentor** architecture powered by a Harness-style pipeline engine.

- `src/cli/` — entry point, REPL loop, argument parsing, slash commands (`commands.ts`), branch commands (`branch-commands.ts`), skills, @-reference resolver, **Ink/React terminal UI** components
- `src/core/agent/` — Intentor (intent + skill classification), Planner (task decomposition), Generator (pipeline-based execution), Evaluator (quality check + auto-refine), Subagent (`subagent.ts` — isolated sub-task execution, sync + concurrent; `subagent-cache.ts` — result cache by input hash), R1 Thought Harvester (`r1-harvester.ts` — recovers tool calls escaped into `reasoning_content`)
- `src/core/pipeline/` — Harness-style pipeline engine (5 stages: prepare context → stream response → process tools → post-process), sharing a `PipelineContext`
- `src/core/tools/` — 11 built-in tools: file read/write/edit, shell execution, directory listing, search, memory read/write (`memory.ts`), web search, code search, `agent_open` (sub-agent delegation). `ToolRegistry` manages registration internally
  - `read_file`: supports `start_line`/`end_line` params; 100KB limit (files >100KB return line count with instructions to use line range)
  - `execute_shell`: `timeout_ms` capped at 300s (5 min); reports captured bytes on timeout
  - `search_files`: `is_regex` (boolean) and `include_hidden` (boolean) params
  - `list_directory`: default limit 500 entries, `max_entries` param up to 2000
  - `agent_open`: delegates a focused research question to an isolated sub-agent (see Subagent section below)
- `src/core/context/` — append-only, cache-first context window management (token budget, soft-trim-from-end on emergency overflow only) and project guide loading
- `src/core/session/` — session persistence (`store.ts`) and session branching (`branching.ts` — fork/switch/tree over per-turn checkpoints)
- `src/core/events/` — typed EventBus for pipeline/tool/LLM lifecycle events
- `src/core/observability/` — structured Logger (v2: file transport, trace IDs, log rotation) + lightweight Metrics (counters, timers, snapshots)
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

**Chat Flow**: Skips Planner/Evaluator, uses Generator pipeline iteratively (up to 30 iterations). Prints fallback text if model returns empty.

**Skill Flow**: Applies skill system prompt + content, then chat-style generation with tool call iteration.

**System prompt stability**: Built once per session, never mutated (maximizes DeepSeek prompt cache hits). For R1 reasoner models, the system prompt is embedded in the first user message.

**Model branching**: `isReasonerModel()` detects R1 variants; `supportsReasoning()` matches V4/Pro models that emit `reasoning_content`. Context budgets: 100k tokens for reasoning models, 90k for chat models. `reasoning_content` is only sent back for the last assistant message (not full history) to reduce token cost.

**Context compaction**: Triggers at 50% token budget (was 80%) or when non-system message count exceeds 30. Keeps 15 recent messages (was 6), summary token limit 1500 (was 512).

## Sub-agent Execution (`src/core/agent/subagent.ts`)

`agent_open` lets the main agent delegate a focused research question to one or more isolated sub-agents. A single call via `runSubagent()` blocks until that sub-agent produces a final text answer or hits `MAX_SUBAGENT_ITERATIONS` (10).

- **Read-only tool set**: `SUBAGENT_TOOL_NAMES` restricts sub-agents to `read_file`, `search_files`, `list_directory`, `code_search`, `web_search`, `memory_read`. No `write_file`/`edit_file`/`execute_shell` — this sidesteps the confirm-dialog stdin/stdout contention that concurrent sub-agents running destructive tools would create, and means sub-agent tool calls never go through `confirmOrSkip`.
- **Isolated context**: sub-agents get a fresh `Message[]` array (system + user only) — they never see the calling agent's conversation history.
- **Model tier**: downgraded to `deepseek-v4-flash` for DeepSeek models by default (same policy as Intentor classification calls); pass `noModelDowngrade: true` to keep the caller's configured model tier.
- **Wiring**: `setSubagentContext(provider, model)` is called once per turn in `runAgentLoop` (and again after model auto-routing) so the `agent_open` tool — which only receives `args: Record<string, unknown>`, not the provider — can reach the LLM. Mirrors the `setTrustMode()` module-level-state pattern in `process-tools-helpers.ts`.
- **Concurrent execution (v0.7)**: `runSubagentsConcurrent()` runs multiple `SubagentRunOptions` tasks in batches via `Promise.allSettled`, capped at `MAX_CONCURRENT_SUBAGENTS` (10) regardless of the requested `concurrency` value. By default a single failed task throws with an aggregated error message; pass `allowPartialFailure: true` to get a mixed success/failure `ConcurrentSubagentResult` instead.
- **Lifecycle management**: each sub-agent has a per-call timeout (`timeoutMs`, default 120s) enforced via an internal `AbortController`; `combineAbortSignals()` merges that timeout signal with any caller-supplied `signal` so external cancellation (e.g. Ctrl+C) and timeout share one abort path.
- **Result caching**: `src/core/agent/subagent-cache.ts` caches results by a sha256 hash of `{task, model, systemOverride, cwd}` (opt-in via `useCache: true`), with a 5-minute TTL and a 100-entry cap (least-accessed entry evicted first). Managed with `/subagent-cache [clear]`.

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

Inspired by Harness CI/CD, each agent interaction is decomposed into 5 stages sharing a `PipelineContext`:

| Stage | Responsibility |
|---|---|
| PrepareContext | Build system prompt, inject project guide, init messages |
| StreamResponse | Stream LLM call, accumulate text/reasoning/tool calls; emits real cacheHitTokens/cacheMissTokens via `core/usage.ts` |
| ProcessToolCalls | Parse tool calls, execute via executor, inject results |
| PostProcess | Blind-write warnings, token stats, final output |

## Tool Confirmation Flow

Destructive tools (`write_file`, `edit_file`, `execute_shell`) are handled in `src/core/pipeline/process-tools-helpers.ts`, which calls `confirmEdit()` in `src/utils/confirm.ts` to show a diff and prompt the user. Choosing "Yes for all" sets a session-level flag. On user rejection, the assistant message `tool_calls` array is trimmed to only the processed calls. `resetYesAll()` is called at the start of each new user turn.

## Skills System

Skills are Markdown files with YAML frontmatter (`name`, `description`, `system`, and body content). They are loaded from `<cwd>/.codegrunt/skills/` (project) and `~/.codegrunt/skills/` (global), and installed from `.zip` archives via `/skills install`. A skill can define a `system` field to completely replace the default coding-assistant identity. Skills are auto-discovered by the Intentor via keyword overlap matching.

## UI / Input

**Ink/React components** (`src/cli/ink/`): `PromptInput.tsx` (main input with cursor, history, autocomplete dropdown), `Dropdown.tsx` (autocomplete overlay), `ListPicker.tsx` (arrow-key selector for model/config selection), `useAutocomplete.ts` (file/slash/skill completion), `useHistory.ts` (persistent command history).

**Legacy input** (`src/cli/input.ts`): Raw-mode terminal input with bottom border + hint line. The accent color throughout is `#4A90D9`. Both the inline dropdown and `selectFromList` use `❯` as the selected-item indicator.

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

Config file is created on first run via the setup wizard (`src/cli/setup.ts`). Env vars take precedence over the config file.

## v0.5 additions (workspace permissions, SWE-bench export, Skills v2, Evaluator v2)

Shipped in v0.1.3 — see `Docs/development-guide.md` roadmap for full context. Summary:

- **`src/core/permissions/index.ts`** — per-workspace, tool-level `allow`/`deny`/`ask` overrides loaded from `.codegrunt/permissions.json`. `deny` takes precedence over everything (including plan/auto trust mode); `ask` always forces a confirm prompt even during session-level yes-for-all. Wired into `process-tools-helpers.ts` via `setWorkspacePermissions()`/`getToolPermission()`. Managed with `/permissions [set <tool> <action> | reset <tool>]`.
- **`src/core/swebench/export.ts`** — `/swebench <instance-id>` exports `git diff HEAD` (staged + unstaged) as a SWE-bench-format JSONL line (`{instance_id, model_patch, model_name_or_path}`), appended to `swebench_predictions.jsonl`. Does not reuse the Side-git snapshot repo — that one tracks per-turn commits on a separate branch, not a single cumulative diff.
- **Skills `mode: subagent`** (`src/cli/skills.ts`) — a skill can set `mode: subagent` in frontmatter to route through the isolated read-only `runSubagent()` loop instead of the main chat loop (no shared history, no write/edit/shell tools). Project skills are now also read from `.claude/skills/` (Claude Code compatible), with priority `.codegrunt/skills/` > `.claude/skills/` > `~/.codegrunt/skills/`.
- **Evaluator v2** — diagnostics logic extracted from `evaluator.ts` into `src/core/lsp/checker.ts` (`runDiagnostics()`/`formatDiagnostics()`), now covering TypeScript/Python/Go/Rust **and ESLint** (new). Evaluation itself remains pure structural checks (no LLM call) — see rationale comment at the top of `evaluator.ts`.

## v0.6 additions (cache-first ContextManager, Schema-aware repair, R1 harvesting)

Roadmap target: 缓存极致 + 成本透明 (see `CodeGrunt-迭代路线图.md` §12). Summary:

- **Append-only `ContextManager`** (`src/core/context/manager.ts`) — `checkCapacity()` no longer proactively splices messages to stay under budget; it only sets `needsCompact`/`nearCapacity` flags. Emergency trimming (`softTrimFromEnd()`) fires only once token count exceeds `budget × 2.0`, and trims from the **end** of the message list (`removeNewestGroup`), never the prefix — this protects the DeepSeek prompt cache. Routine compaction is otherwise user-triggered via `/compact`.
- **`/cache` command** (`src/cli/commands.ts`) — `printCacheStats()` reports cache hit rate and estimated savings from `getSessionUsage()`.
- **`/cost-report` command** — `printCostReport()` shows today/this-month usage with cache-derived savings estimate.
- **`/effort` (`/reasoning`) command** — `switchReasoningEffort()` toggles R1 reasoning effort between low/medium/high per turn.
- **Schema-aware tool-call repair** — `repairToolArgs(argsJson, toolName)` in `src/core/pipeline/stages/process-tools-helpers.ts` now takes the tool name so repair can validate against that tool's expected parameter names/types, not just fix JSON syntax.
- **R1 Thought Harvesting** (`src/core/agent/r1-harvester.ts`) — `harvestToolCalls()` scans `reasoning_content` for patterns like `tool_name({...})` that R1 "thought about" but never emitted as a formal tool call; `filterNonEscaped()` excludes any that were already issued for real, `deduplicateHarvested()` collapses duplicates by (tool, first-arg) key. Wired into `post-process.ts`, triggered only when the model produced no formal tool calls and no text output. Covered by `tests/agent/r1-harvester.test.ts` (12 cases).

## v0.7 additions (concurrent sub-agents, session branching)

Roadmap target: 并发编排 + 会话分支 (see `CodeGrunt-迭代路线图.md` §12). Summary:

- **Concurrent sub-agents** — see the "Concurrent execution (v0.7)" and "Lifecycle management" bullets in the Sub-agent Execution section above (`runSubagentsConcurrent()`, `subagent-cache.ts`).
- **Session branching** (`src/core/session/branching.ts` + `src/cli/branch-commands.ts`) — a `BranchTree` persisted per-session at `~/.codegrunt/branches/<session-id>.branches.json` records a flat list of `Checkpoint`s (turn index, message count, summary) per `Branch`. `forkBranch()` creates a new branch pointing at a historical checkpoint on an existing branch; `switchToBranch()` returns the message count to restore to; `visualizeBranchTree()` renders an ASCII tree. Exposed via `/branch <turn-number>`, `/tree`, `/switch <branch-id>` (registered in `commands.ts`). `recordCheckpoint()` is called automatically after each turn in `repl.ts`. Covered by `tests/core/branching.test.ts` (21 cases).

## Known Issues & Technical Debt

### Test coverage gaps

Still not tested: `list_directory`, `search_files`, all 4 pipeline stages individually, `compact.ts` chunking logic, `at-resolver.ts`, `skills.ts` zip install, `lsp/checker.ts` diagnostics.

Also missing: `useAutocomplete.ts`/`PromptInput.tsx` history-vs-dropdown interaction beyond the pure-function unit tests in `tests/cli/useAutocomplete.test.ts` (no Ink component-level test harness yet), `branch-commands.ts` slash-command wiring (branching.ts itself is tested, the CLI handler is not).

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
