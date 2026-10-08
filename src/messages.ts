// ── Message types (OpenAI-compatible) ──────────────────────────────────────
// Kept free of imports so any layer (context manager, providers, pipeline) can
// depend on them without pulling in the rest of the shared types.

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
