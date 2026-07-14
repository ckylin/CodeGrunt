// ── Message types (OpenAI-compatible) ──────────────────────────────────────

export interface TextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** DeepSeek reasoning / chain-of-thought — persisted across turns for continuity */
  reasoning_content?: string;
}

export interface ToolCallMessage {
  role: 'assistant';
  content: null;
  tool_calls: ToolCall[];
  /** DeepSeek reasoning that led to the tool calls */
  reasoning_content?: string;
}

export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type Message = TextMessage | ToolCallMessage | ToolResultMessage;

// ── Tool call structures ────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ── Streaming chunks ────────────────────────────────────────────────────────

export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments_delta: string }
  | { type: 'finish'; finish_reason: 'stop' | 'tool_calls' | 'length' };

// ── Tool interfaces ─────────────────────────────────────────────────────────

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  userRejected?: boolean;
  /** Time spent waiting for user confirmation (ms), excluded from exec duration */
  confirmDurationMs?: number;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

// ── Provider interface ──────────────────────────────────────────────────────

export interface RequestOptions {
  model: string;
  maxTokens: number;
  /** Omit for DeepSeek reasoner (R1) models — they don't support temperature */
  temperature?: number;
  /** DeepSeek R1 reasoning effort: 'low' | 'medium' | 'high' (default: 'medium') */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Nucleus sampling — DeepSeek supports top_p alongside temperature */
  topP?: number;
  /** Penalize token repetition (DeepSeek: -2.0 to 2.0) */
  frequencyPenalty?: number;
  /** Penalize new tokens based on presence so far (DeepSeek: -2.0 to 2.0) */
  presencePenalty?: number;
  /** DeepSeek V4 thinking mode toggle — V4 models think by default; set 'disabled' for fast, non-reasoning responses */
  thinking?: 'enabled' | 'disabled';
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly id: string;
  stream(messages: Message[], options: RequestOptions): AsyncIterable<StreamChunk>;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface CodeGruntConfig {
  provider: string;
  model: string;
  maxTokens: number;
  temperature: number;
  apiKey: string;
  baseURL: string;
  /** DeepSeek R1 reasoning effort: 'low' | 'medium' | 'high' */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Nucleus sampling */
  topP?: number;
  /** Penalize token repetition */
  frequencyPenalty?: number;
  /** Penalize new tokens based on presence */
  presencePenalty?: number;
  /**
   * Trust mode controls how destructive tool calls are handled:
   * - plan: read-only — execute_shell and all write tools are blocked
   * - code: require confirmation for each destructive operation (default)
   * - auto: auto-approve all operations (session-wide yes-for-all)
   */
  trustMode?: 'plan' | 'code' | 'auto';
  /** Web search engine: 'mojeek' (default) | 'searxng' | 'duckduckgo' */
  searchEngine?: 'mojeek' | 'searxng' | 'duckduckgo';
  /** SearXNG instance URL — used when searchEngine is 'searxng' */
  searxngUrl?: string;
}

// ── Habit tracking ──────────────────────────────────────────────────────────

export interface TurnSignal {
  userInputLength: number;
  userInputLang: 'zh' | 'en';
  responseLength: number;
  isCoding: boolean;
  toolCallCount: number;
  confirmations: number;
  rejections: number;
  yesAll: boolean;
  aborted: boolean;
}

// ── Agent ───────────────────────────────────────────────────────────────────

export interface AgentRunOptions {
  task: string;
  cwd: string;
  config: CodeGruntConfig;
  provider: LLMProvider;
  context?: import('./core/context/manager.js').ContextManager;
  /** When provided, replaces the default coding-assistant system prompt.
   *  Used by skills to define a completely different role/identity. */
  systemPromptOverride?: string;
  /** Loaded skills — passed to Intentor for automatic skill routing. */
  skills?: import('./cli/skills.js').Skill[];
  /** Session summary from previous compact — injected into system prompt at startup. */
  memorySummary?: string;
  /** Formatted user habit preferences — injected into system prompt above session summary. */
  userPreferences?: string;
  /** System language, detected once at REPL startup. Defaults to 'en' if omitted. */
  language?: 'zh' | 'en';
  onText?: (text: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
  /** Called at the end of each agent turn with observable behavior signals for habit tracking. */
  onTurnComplete?: (signal: TurnSignal) => void;
  signal?: AbortSignal;
}
