// ── Scripted Mock LLMProvider ────────────────────────────────────────────────
// Existing inline provider stubs in the test suite (tests/pipeline/engine.test.ts,
// tests/agent/loop-autocompact.test.ts) only ever yield a single 'finish' chunk —
// enough for pipeline-engine-mechanics tests, but not enough to drive a real
// multi-turn tool-call conversation through the actual 4 stages. This helper
// lets a test script a SEQUENCE of turns (text-only, tool-call, or both), one
// per call to provider.stream() — call N of stream() returns script[N].

import type { LLMProvider, Message, RequestOptions, StreamChunk } from '../../src/types.js';

export interface ScriptedTurn {
  /** Plain assistant text to stream as one or more text_delta chunks. */
  text?: string;
  /** Tool calls to stream as tool_call_delta chunks (accumulated by
   *  StreamResponseStage the same way real provider deltas are). */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** Defaults to 'tool_calls' when toolCalls is set, otherwise 'stop'. */
  finishReason?: 'stop' | 'tool_calls' | 'length';
}

export interface ScriptedProviderCall {
  messages: Message[];
  options: RequestOptions;
}

/**
 * Creates a mock LLMProvider that streams `script[callIndex]` on the Nth call
 * to stream(), clamping to the last scripted turn if stream() is called more
 * times than the script has entries (so a test doesn't need to predict the
 * exact call count to avoid an out-of-bounds error).
 *
 * Every call's (messages, options) is recorded in `.calls` for assertions
 * about what the pipeline actually sent to the "model".
 */
export function createScriptedProvider(script: ScriptedTurn[]): LLMProvider & { calls: ScriptedProviderCall[] } {
  const calls: ScriptedProviderCall[] = [];
  let callCount = 0;

  return {
    id: 'scripted-mock',
    calls,
    async *stream(messages: Message[], options: RequestOptions): AsyncIterable<StreamChunk> {
      calls.push({ messages: [...messages], options });
      const turn = script[Math.min(callCount, script.length - 1)];
      callCount++;

      if (turn.text) {
        yield { type: 'text_delta', text: turn.text };
      }

      if (turn.toolCalls) {
        for (let i = 0; i < turn.toolCalls.length; i++) {
          const tc = turn.toolCalls[i];
          yield { type: 'tool_call_delta', index: i, id: tc.id, name: tc.name, arguments_delta: tc.arguments };
        }
      }

      const finishReason = turn.finishReason ?? (turn.toolCalls ? 'tool_calls' : 'stop');
      yield { type: 'finish', finish_reason: finishReason };
    },
  };
}
