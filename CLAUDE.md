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

- `src/cli/` — entry point, REPL loop, argument parsing, slash commands, skills, @-reference resolver, **Ink/React terminal UI** components
- `src/core/agent/` — Intentor (intent + skill classification), Planner (task decomposition), Generator (pipeline-based execution), Evaluator (quality check + auto-refine)
- `src/core/pipeline/` — Harness-style pipeline engine (5 stages: prepare context → stream response → process tools → post-process), sharing a `PipelineContext`
- `src/core/tools/` — 8 built-in tools: file read/write/edit, shell execution, directory listing, search, memory read/write (`memory.ts`). `ToolRegistry` manages registration internally
  - `read_file`: supports `start_line`/`end_line` params; 100KB limit (files >100KB return line count with instructions to use line range)
  - `execute_shell`: `timeout_ms` capped at 300s (5 min); reports captured bytes on timeout
  - `search_files`: `is_regex` (boolean) and `include_hidden` (boolean) params
  - `list_directory`: default limit 500 entries, `max_entries` param up to 2000
- `src/core/context/` — context window management (token budget, trimming) and project guide loading
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
3. **Evaluator**: Quality check + auto-refine (max 3 retries, then prompts user whether to continue). Matches 14 error patterns; auto-runs `tsc --noEmit` after write/edit on TS projects. `pruneRefineMessages` cleans eval feedback between steps
4. `sessionHasRead` tracking prevents redundant file reads across turns

**Chat Flow**: Skips Planner/Evaluator, uses Generator pipeline iteratively (up to 30 iterations). Prints fallback text if model returns empty.

**Skill Flow**: Applies skill system prompt + content, then chat-style generation with tool call iteration.

**System prompt stability**: Built once per session, never mutated (maximizes DeepSeek prompt cache hits). For R1 reasoner models, the system prompt is embedded in the first user message.

**Model branching**: `isReasonerModel()` detects R1 variants; `supportsReasoning()` matches V4/Pro models that emit `reasoning_content`. Context budgets: 100k tokens for reasoning models, 90k for chat models. `reasoning_content` is only sent back for the last assistant message (not full history) to reduce token cost.

**Context compaction**: Triggers at 50% token budget (was 80%) or when non-system message count exceeds 30. Keeps 15 recent messages (was 6), summary token limit 1500 (was 512).

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

## Known Issues & Technical Debt

### Remaining low severity — dead code / gaps

| Issue | Location |
|---|---|
| `ignore` package imported in `package.json` but never used | — |

### Test coverage gaps

Still not tested: `list_directory`, `search_files`, all 4 pipeline stages individually, `compact.ts` chunking logic, `at-resolver.ts`, `skills.ts` zip install.

---

## Priority Work Items

### P0 — Correctness bugs ✅ Done

1. ~~**Fix `systemPromptOverride` in `PrepareContextStage`**~~ — done
2. ~~**Fix `edit_file` multi-occurrence behavior**~~ — done

### P1 — Core feature completeness ✅ Done

3. ~~**Wire auto-compact into `ContextManager`**~~ — done: triggers at 50% budget or >30 messages
4. ~~**Remove `executor.ts` dead code**~~ — done: file deleted
5. ~~**De-duplicate `detectSystemLanguage()`**~~ — done: extracted to `src/utils/locale.ts`

### P2 — Test coverage ✅ Done

6. ~~**`edit_file` unit tests**~~ — done
7. ~~**`ContextManager` tests**~~ — done
8. ~~**`Intentor` + `Planner` tests**~~ — done
9. ~~**Pipeline stage integration test**~~ — done

### P3 — Cleanup ✅ Done

10. ~~Remove dead code: `classifier.ts`, `showSlashCommandSelector` stub, `ServiceContainer`/DI system~~ — done: all deleted
11. ~~Emit `ConversationTrimmedEvent`~~ — removed from EventBus along with other unused event types
12. Remove unused `ignore` dependency from `package.json`
