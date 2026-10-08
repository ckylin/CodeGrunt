import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { runSkillFlow } from '../../src/core/agent/skill-flow.js';
import { MAX_ITERATIONS } from '../../src/core/agent/generator.js';
import { createScriptedProvider } from '../helpers/mock-provider.js';
import { setupFlowEnv, makeOptions, newContext, metrics, outputOf, type FlowEnv } from './_flow-harness.js';

const inlineSkill = {
  name: 'pirate',
  content: 'Answer like a pirate.',
  system: 'You are a pirate assistant.',
};

describe('runSkillFlow (characterization)', () => {
  let env: FlowEnv;

  beforeEach(async () => { env = await setupFlowEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it('inline: announces the skill, applies its system prompt, and prefixes the task with the skill body', async () => {
    const provider = createScriptedProvider([{ text: 'Arr, hello.' }]);
    const context = newContext();
    const result = await runSkillFlow(makeOptions(env, provider, 'say hi'), context, 'en', inlineSkill, metrics());

    expect(result.responseLength).toBe('Arr, hello.'.length);
    expect(outputOf(env)).toContain('skill: pirate');

    const sent = provider.calls[0].messages;
    const user = sent.find((m) => m.role === 'user') as { content: string };
    expect(user.content).toContain('Answer like a pirate.');
    expect(user.content).toContain('---\nsay hi');
  });

  // KNOWN QUIRK (pinned as-is, not endorsed): see the matching test in
  // chat-flow.test.ts. The skill's `system` override is applied to
  // ctx.systemPrompt but never reaches the provider on a fresh context.
  it('inline: currently does NOT send the skill system prompt as a system message on a fresh context', async () => {
    const provider = createScriptedProvider([{ text: 'Arr.' }]);
    await runSkillFlow(makeOptions(env, provider, 'say hi'), newContext(), 'en', inlineSkill, metrics());
    expect(provider.calls[0].messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('inline: behaves like chat for tool calls (executes, feeds back, continues)', async () => {
    await writeFile(join(env.dir, 'n.txt'), 'body-text');
    const provider = createScriptedProvider([
      { toolCalls: [{ id: 's1', name: 'read_file', arguments: JSON.stringify({ path: 'n.txt' }) }] },
      { text: 'Done reading.' },
    ]);
    const onToolResult = vi.fn();
    const context = newContext();
    const result = await runSkillFlow(
      makeOptions(env, provider, 'read n.txt', { onToolResult }), context, 'en', inlineSkill, metrics(),
    );

    expect(provider.calls).toHaveLength(2);
    expect(result.responseLength).toBe('Done reading.'.length);
    expect(onToolResult.mock.calls[0][1].output).toContain('body-text');
    expect(context.getMessages().some((m) => m.role === 'tool')).toBe(true);
  });

  it('inline: caps a never-ending tool loop at MAX_ITERATIONS', async () => {
    await writeFile(join(env.dir, 'a.txt'), 'x');
    const provider = createScriptedProvider([
      { toolCalls: [{ id: 'loop', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }] },
    ]);
    await runSkillFlow(makeOptions(env, provider, 'loop'), newContext(), 'en', inlineSkill, metrics());
    expect(provider.calls).toHaveLength(MAX_ITERATIONS);
  }, 30_000);

  it('inline: stops once the abort signal fires', async () => {
    await writeFile(join(env.dir, 'a.txt'), 'x');
    const ac = new AbortController();
    const provider = createScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }] },
      { text: 'never' },
    ]);
    await runSkillFlow(
      makeOptions(env, provider, 'go', { signal: ac.signal, onToolCall: () => ac.abort() }),
      newContext(), 'en', inlineSkill, metrics(),
    );
    expect(provider.calls).toHaveLength(1);
  });

  it('inline: counts the turn in metrics', async () => {
    const m = metrics();
    const spy = vi.spyOn(m, 'increment');
    await runSkillFlow(makeOptions(env, createScriptedProvider([{ text: 'ok' }]), 'x'), newContext(), 'en', inlineSkill, m);
    expect(spy).toHaveBeenCalledWith('agent.skill_turns');
  });

  it('subagent mode: runs isolated (own system prompt, main context untouched) and streams the answer via onText', async () => {
    const provider = createScriptedProvider([{ text: 'Findings: all good.' }]);
    const onText = vi.fn();
    const context = newContext();
    const skill = { name: 'research', content: 'Investigate.', system: 'You are a researcher.', mode: 'subagent' as const };
    const result = await runSkillFlow(makeOptions(env, provider, 'look into it', { onText }), context, 'en', skill, metrics());

    expect(result.responseLength).toBe('Findings: all good.'.length);
    expect(onText).toHaveBeenCalledWith('Findings: all good.');
    expect(provider.calls[0].messages[0]).toEqual({ role: 'system', content: 'You are a researcher.' });
    expect((provider.calls[0].messages[1] as { content: string }).content).toContain('Investigate.');
    expect(context.getMessages()).toHaveLength(0);
    const toolNames = (provider.calls[0].options.tools ?? []).map((t) => t.function.name);
    expect(toolNames).not.toContain('write_file');
    expect(toolNames).not.toContain('execute_shell');
    expect(toolNames).toContain('read_file');
  });
});
