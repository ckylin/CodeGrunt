import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { runChatFlow } from '../../src/core/agent/chat-flow.js';
import { MAX_ITERATIONS } from '../../src/core/agent/generator.js';
import { setTrustMode } from '../../src/core/policy/state.js';
import { createScriptedProvider } from '../helpers/mock-provider.js';
import { setupFlowEnv, makeOptions, newContext, metrics, outputOf, type FlowEnv } from './_flow-harness.js';
import type { LLMProvider } from '../../src/types.js';

describe('runChatFlow (characterization)', () => {
  let env: FlowEnv;

  beforeEach(async () => { env = await setupFlowEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('answers with text only: one provider call, assistant message appended, length returned', async () => {
    const provider = createScriptedProvider([{ text: 'Hello there.' }]);
    const context = newContext();
    const result = await runChatFlow(makeOptions(env, provider, 'hi'), context, 'en', metrics());

    expect(result).toEqual({ responseLength: 'Hello there.'.length });
    expect(provider.calls).toHaveLength(1);
    const msgs = context.getMessages();
    expect(msgs.some((m) => m.role === 'user' && String(m.content).endsWith('hi'))).toBe(true);
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('assistant');
    expect((last as { content: string }).content).toBe('Hello there.');
  });

  // KNOWN QUIRK (pinned as-is, not endorsed): runGenerator pushes the user
  // message BEFORE PrepareContextStage runs, so its `messages.length === 0`
  // guard never fires and a fresh non-reasoner context gets no system message.
  // If this is fixed on purpose, flip this assertion.
  it('currently sends no system message on a fresh context (first message is the cwd-prefixed user turn)', async () => {
    const provider = createScriptedProvider([{ text: 'ok' }]);
    await runChatFlow(makeOptions(env, provider, 'hi'), newContext(), 'en', metrics());
    const sent = provider.calls[0].messages;
    expect(sent.some((m) => m.role === 'system')).toBe(false);
    expect(sent[0].role).toBe('user');
    expect(String((sent[0] as { content: string }).content)).toMatch(/^\[cwd: .+\]\n\nhi$/);
  });

  it('executes a tool call, feeds the result back, and continues to a final answer', async () => {
    await writeFile(join(env.dir, 'note.txt'), 'secret-body');
    const provider = createScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) }] },
      { text: 'The file says secret-body.' },
    ]);
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const context = newContext();
    const result = await runChatFlow(
      makeOptions(env, provider, 'read note.txt', { onToolCall, onToolResult }),
      context, 'en', metrics(),
    );

    expect(provider.calls).toHaveLength(2);
    expect(result.responseLength).toBe('The file says secret-body.'.length);
    expect(onToolCall).toHaveBeenCalledWith('read_file', { path: 'note.txt' });
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult.mock.calls[0][0]).toBe('read_file');
    expect(onToolResult.mock.calls[0][1].output).toContain('secret-body');

    const msgs = context.getMessages();
    const toolMsg = msgs.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(String((toolMsg as { content: string }).content)).toContain('secret-body');
    // The second request must carry the tool result back to the model.
    expect(provider.calls[1].messages.some((m) => m.role === 'tool')).toBe(true);
    expect((msgs[msgs.length - 1] as { content: string }).content).toBe('The file says secret-body.');
  });

  it('prints the fallback line when the model returns nothing at all (en)', async () => {
    const provider = createScriptedProvider([{}]);
    const result = await runChatFlow(makeOptions(env, provider, 'hi'), newContext(), 'en', metrics());
    expect(result.responseLength).toBe(0);
    expect(outputOf(env)).toContain('(no text response from model)');
  });

  it('prints the localized fallback line (zh)', async () => {
    const provider = createScriptedProvider([{}]);
    await runChatFlow(makeOptions(env, provider, 'hi', { language: 'zh' }), newContext(), 'zh', metrics());
    expect(outputOf(env)).toContain('(模型未返回文本响应)');
  });

  it('does not print the fallback when the model replied with text', async () => {
    const provider = createScriptedProvider([{ text: 'ok' }]);
    await runChatFlow(makeOptions(env, provider, 'hi'), newContext(), 'en', metrics());
    expect(outputOf(env)).not.toContain('no text response');
  });

  it('caps a never-ending tool loop at MAX_ITERATIONS provider calls', async () => {
    await writeFile(join(env.dir, 'a.txt'), 'x');
    const provider = createScriptedProvider([
      { toolCalls: [{ id: 'loop', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }] },
    ]);
    const result = await runChatFlow(makeOptions(env, provider, 'loop forever'), newContext(), 'en', metrics());
    expect(provider.calls).toHaveLength(MAX_ITERATIONS);
    expect(result.responseLength).toBe(0);
  }, 30_000);

  it('stops iterating once the abort signal fires', async () => {
    await writeFile(join(env.dir, 'a.txt'), 'x');
    const ac = new AbortController();
    const provider = createScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }] },
      { text: 'should never be requested' },
    ]);
    await runChatFlow(
      makeOptions(env, provider, 'read it', { signal: ac.signal, onToolCall: () => ac.abort() }),
      newContext(), 'en', metrics(),
    );
    expect(provider.calls).toHaveLength(1);
  });

  it('ends with length 0 and writes nothing when the user rejects a tool call (plan mode)', async () => {
    setTrustMode('plan');
    const provider = createScriptedProvider([
      { toolCalls: [{ id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'x' }) }] },
      { text: 'unreachable' },
    ]);
    const result = await runChatFlow(makeOptions(env, provider, 'write it'), newContext(), 'en', metrics());
    expect(result.responseLength).toBe(0);
    expect(provider.calls).toHaveLength(1);
    const { access } = await import('fs/promises');
    await expect(access(join(env.dir, 'out.txt'))).rejects.toThrow();
  });

  it('rethrows a provider/pipeline error', async () => {
    const failing: LLMProvider = {
      id: 'failing',
      // eslint-disable-next-line require-yield
      async *stream() { throw new Error('upstream exploded'); },
    };
    await expect(runChatFlow(makeOptions(env, failing, 'hi'), newContext(), 'en', metrics()))
      .rejects.toThrow('upstream exploded');
  });

  it('counts the turn in metrics', async () => {
    const m = metrics();
    const spy = vi.spyOn(m, 'increment');
    await runChatFlow(makeOptions(env, createScriptedProvider([{ text: 'ok' }]), 'hi'), newContext(), 'en', m);
    expect(spy).toHaveBeenCalledWith('agent.chat_turns');
  });
});
