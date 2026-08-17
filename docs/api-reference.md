# CodeGrunt API Reference (Draft)

> **Status: draft.** This covers the core internal interfaces a contributor
> or plugin author needs — `LLMProvider`, `Tool`, and the pipeline
> `Stage`/`PipelineContext` contract. It documents `src/types.ts` and
> `src/core/pipeline/types.ts` as of v0.9. There is no public npm package
> API yet (CodeGrunt is a CLI, not a library) — this is for people extending
> or embedding the codebase itself, per the v1.0 roadmap's plugin system
> item. Keep this in sync with the source when either file changes; it will
> drift otherwise.

## Table of contents

- [LLMProvider](#llmprovider)
- [Tool](#tool)
- [Pipeline: Stage and PipelineContext](#pipeline-stage-and-pipelinecontext)
- [Message types](#message-types)

---

## LLMProvider

Every LLM backend implements this interface (`src/types.ts`). The only
built-in implementation is `src/providers/deepseek/provider.ts`.

```typescript
export interface LLMProvider {
  readonly id: string;
  stream(messages: Message[], options: RequestOptions): AsyncIterable<StreamChunk>;
}
```

- `id` — a short identifier for logging/config (`'deepseek'`).
- `stream()` — takes the full conversation and yields `StreamChunk`s as the
  model responds. There is no non-streaming variant; even a single-shot
  response is expected to arrive as a stream that ends in a `finish` chunk.

### RequestOptions

```typescript
export interface RequestOptions {
  model: string;
  maxTokens: number;
  temperature?: number;         // omit for reasoner (R1) models — they reject it
  reasoningEffort?: 'low' | 'medium' | 'high';
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  thinking?: 'enabled' | 'disabled';
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}
```

### StreamChunk

A discriminated union on `type`:

```typescript
export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments_delta: string }
  | { type: 'finish'; finish_reason: 'stop' | 'tool_calls' | 'length' };
```

- `text_delta` — a chunk of the assistant's visible reply.
- `reasoning_delta` — chain-of-thought content (DeepSeek R1/V4-specific).
  Providers without a reasoning concept simply never yield this.
- `tool_call_delta` — one tool call's data, streamed incrementally. `index`
  identifies which tool call within the batch this delta belongs to (a
  single turn can emit several tool calls); `id`/`name` typically arrive on
  the first delta for that index, `arguments_delta` is a fragment of the
  JSON arguments string to be concatenated across deltas.
  `StreamResponseStage` (`src/core/pipeline/stages/stream-response.ts`) owns
  the accumulation logic — a provider implementation never needs to buffer
  these itself.
- `finish` — terminates the stream. `finish_reason` is one of `'stop'`
  (natural end), `'tool_calls'` (model wants to call tools — the pipeline
  loops back for another turn after executing them), or `'length'`
  (truncated by `maxTokens`).

Adding a new provider means writing a class that implements `LLMProvider`
and translating between your backend's SDK/response format and this shape.
See "添加新的 LLM 提供商" in `Docs/development-guide.md` for the concrete
walkthrough (project decision: DeepSeek-only for now — see the memory note
on provider strategy — so a second provider is a contribution scenario, not
something the core team plans to add itself).

---

## Tool

Tools are what the model calls to interact with the filesystem/shell/etc.
(`src/types.ts`, registered in `src/core/tools/registry.ts`).

```typescript
export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  userRejected?: boolean;
  confirmDurationMs?: number;
}
```

- `definition` is the JSON-Schema-based function definition sent to the
  model — same shape OpenAI's function-calling API expects.
- `execute()` receives the model's parsed arguments and returns a
  `ToolResult`. **Never throw from `execute()` for an expected failure case**
  (file not found, ambiguous match, etc.) — return
  `{ success: false, error: '...' }` instead, so the failure is reported back
  to the model as something it can react to. An actual thrown exception is
  caught by `executeToolCall()` in
  `src/core/pipeline/stages/process-tools-helpers.ts`, wrapped in a
  `ToolError` for logging, and converted to a graceful `ToolResult` anyway —
  but returning one directly is the intended path.
- `userRejected: true` signals the user declined a confirmation prompt
  (write/edit/shell tools go through `confirmOrSkip`/`confirmShellOrSkip`
  first) — the pipeline halts the current batch rather than treating it as
  an ordinary tool failure.

Destructive tools (`write_file`, `edit_file`, `execute_shell`) are handled
specially in `process-tools-helpers.ts`, which gates them behind the
confirm-dialog / trust-mode / workspace-permission logic before calling
`execute()`. A new tool only needs this special handling if it's also
destructive — read-only tools (`read_file`, `search_files`, ...) go straight
through.

11 built-in tools exist today (see CLAUDE.md's tools section for the current
list and any per-tool limits/params). See "添加新工具" in
`Docs/development-guide.md` for the registration walkthrough.

---

## Pipeline: Stage and PipelineContext

Each agent turn runs through a 4-stage pipeline
(`src/core/pipeline/engine.ts` + `src/core/pipeline/stages/*.ts`), modeled on
Harness CI/CD's pipeline pattern. All 4 built-in stages plus the engine
itself are internal, but the `Stage` interface is stable and testable in
isolation (see `tests/pipeline/engine.test.ts` for stub-stage examples and
`tests/integration/pipeline-e2e.test.ts` for the real stages wired together).

```typescript
export interface Stage {
  readonly name: string;
  execute(ctx: PipelineContext): Promise<StageResult>;
}

export interface StageResult {
  continue: boolean;        // false → stop pipeline execution here
  done: boolean;             // true → this is a terminal result for the whole turn
  userRejected?: boolean;    // true → user declined a confirmation; halt immediately
}
```

The 4 built-in stages, in order:

| Stage | File | Responsibility |
|---|---|---|
| `PrepareContextStage` | `prepare-context.ts` | Builds the system prompt (once per session), loads the project guide, pushes the system message on the first turn. |
| `StreamResponseStage` | `stream-response.ts` | Calls `provider.stream()`, accumulates `StreamChunk`s into `ctx.assistantText`/`ctx.reasoningText`/`ctx.toolCalls`. |
| `ProcessToolCallsStage` | `process-tools.ts` | Executes each accumulated tool call (via `executeToolCall()`), handles the confirm flow for destructive tools, appends `tool` result messages. |
| `PostProcessStage` | `post-process.ts` | Decides whether the turn is done (`finishReason === 'stop'/'length'`) or should loop again (`'tool_calls'`); also runs R1 "thought harvesting" (recovers tool calls that leaked into `reasoning_content` instead of a formal tool call). |

### PipelineContext

The shared, mutable state object every stage reads and writes
(`src/core/pipeline/types.ts`). Selected fields:

```typescript
export interface PipelineContext {
  cwd: string;
  config: CodeGruntConfig;
  provider: LLMProvider;
  messages: Message[];              // the full conversation, mutated in place
  systemPrompt: string;
  isReasoner: boolean;
  task: string;                     // this turn's instruction
  toolDefinitions: ToolDefinition[];
  signal?: AbortSignal;
  maxIterations: number;
  iteration: number;
  reasoningText: string;            // reset each turn by StreamResponseStage
  assistantText: string;            // reset each turn by StreamResponseStage
  toolCalls: ToolCall[];            // reset each turn by StreamResponseStage
  finishReason: 'stop' | 'tool_calls' | 'length' | null;
  outputTokens: number;
  hasReadThisTurn: boolean;         // anti-hallucination: was a read tool called this turn?
  warnedBlindWrite: boolean;
  language: 'zh' | 'en';
  // Optional P/G/E fields (set by Planner/Evaluator, outside the 4 core stages):
  plan?: TaskPlan;
  planStepIndex?: number;
  lastEvaluation?: EvaluationResult;
  refineCount?: number;
}
```

A test building a `PipelineContext` by hand needs every non-optional field
populated — see `makeCtx()` helpers in `tests/pipeline/engine.test.ts` and
`tests/integration/pipeline-e2e.test.ts` for working examples, or
`tests/agent/loop-autocompact.test.ts` for another variant.

### Writing a new stage

A custom stage is a class implementing `Stage`, added via
`PipelineBuilder.addStage()`:

```typescript
class MyStage implements Stage {
  readonly name = 'my-stage';
  async execute(ctx: PipelineContext): Promise<StageResult> {
    // read/mutate ctx as needed
    return { continue: true, done: false };
  }
}

const pipeline = new PipelineBuilder()
  .name('my-pipeline')
  .addStage(new MyStage())
  .addStage(/* ... */)
  .build();

const result = await new PipelineEngine().execute(pipeline, ctx);
```

There is no plugin-registration mechanism for stages yet — the roadmap's
v1.0 "插件系统正式化" item covers formalizing this (`Stage` as a public
extension point via an npm package, `/plugin install <package>`). Today,
adding a stage means editing `src/core/agent/generator.ts` where the 4
built-in stages are wired together.

---

## Message types

```typescript
export type Message = TextMessage | ToolCallMessage | ToolResultMessage;

export interface TextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning_content?: string; // only ever set on the LAST assistant message re-sent to the API
}

export interface ToolCallMessage {
  role: 'assistant';
  content: null;
  tool_calls: ToolCall[];
  reasoning_content?: string;
}

export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}
```

Note the `reasoning_content` cost optimization: only the most recent
assistant message carries it back to the provider on the next call — resending
older chain-of-thought on every turn would double input token cost for no
benefit. See CLAUDE.md's Agent Loop section for the full rationale.
