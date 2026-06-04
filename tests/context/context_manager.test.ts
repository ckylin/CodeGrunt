import { describe, it, expect, beforeEach } from 'vitest';
import { ContextManager } from '../../src/core/context/manager.js';
import type { Message } from '../../src/types.js';

// ── helpers ──────────────────────────────────────────────────────────────

function userMsg(content: string): Message {
  return { role: 'user', content };
}

function assistantMsg(content: string): Message {
  return { role: 'assistant', content };
}

function systemMsg(content: string): Message {
  return { role: 'system', content };
}

/** Build a paired assistant(tool_calls) + tool result group */
function toolGroup(toolCallId = 'tc1'): Message[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    } as Message,
    { role: 'tool', tool_call_id: toolCallId, content: 'file contents' } as Message,
  ];
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('ContextManager', () => {
  let ctx: ContextManager;

  beforeEach(() => {
    ctx = new ContextManager(90_000);
  });

  it('stores and retrieves messages', () => {
    ctx.push(userMsg('hello'));
    ctx.push(assistantMsg('hi'));
    expect(ctx.getMessages()).toHaveLength(2);
  });

  it('clear() empties the message list', () => {
    ctx.push(userMsg('a'));
    ctx.clear();
    expect(ctx.getMessages()).toHaveLength(0);
  });

  it('compact() replaces messages with summary, preserving system message', () => {
    ctx.push(systemMsg('You are an assistant.'));
    ctx.push(userMsg('first question'));
    ctx.push(assistantMsg('first answer'));
    ctx.compact('summary of prior conversation');
    const msgs = ctx.getMessages();
    // system + user(summary) + assistant(ack)
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect((msgs[1] as any).content).toContain('summary of prior conversation');
    expect(msgs[2].role).toBe('assistant');
  });

  it('compact() works without a system message', () => {
    ctx.push(userMsg('q'));
    ctx.push(assistantMsg('a'));
    ctx.compact('brief summary');
    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(2); // user(summary) + assistant(ack)
    expect(msgs[0].role).toBe('user');
  });

  it('setTokenBudget() applies immediately and triggers trim if over budget', () => {
    // Fill with content that stays under 90k
    for (let i = 0; i < 10; i++) {
      ctx.push(userMsg('a'.repeat(100)));
      ctx.push(assistantMsg('b'.repeat(100)));
    }
    const before = ctx.getMessages().length;
    // Set a tiny budget to force trim
    ctx.setTokenBudget(50);
    expect(ctx.getMessages().length).toBeLessThan(before);
  });

  describe('needsCompact flag', () => {
    it('is false initially', () => {
      expect(ctx.needsCompact).toBe(false);
    });

    it('is set to true when token usage exceeds 80% of budget', () => {
      // budget = 1000 tokens → 80% = 800 tokens → 3200 chars
      const smallCtx = new ContextManager(1_000);
      // Push ~850 tokens worth of content (one message slightly over threshold)
      smallCtx.push(userMsg('x'.repeat(3_500)));
      expect(smallCtx.needsCompact).toBe(true);
    });

    it('remains false when under the threshold', () => {
      const smallCtx = new ContextManager(1_000);
      smallCtx.push(userMsg('x'.repeat(100)));
      expect(smallCtx.needsCompact).toBe(false);
    });
  });

  describe('trim — tool call pairing preservation', () => {
    it('does not leave orphaned tool messages when trimming', () => {
      // budget = 500 tokens
      const tinyCtx = new ContextManager(500);
      // Fill with paired tool groups to force trimming
      for (let i = 0; i < 20; i++) {
        const [asst, tool] = toolGroup(`tc${i}`);
        tinyCtx.push(asst);
        tinyCtx.push(tool);
      }
      const msgs = tinyCtx.getMessages();
      // Verify no orphaned tool messages (every tool msg must be preceded by
      // an assistant(tool_calls) msg that references its tool_call_id)
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.role === 'tool') {
          const prev = msgs[i - 1];
          expect(prev).toBeDefined();
          expect(prev.role).toBe('assistant');
          expect('tool_calls' in prev && prev.tool_calls).toBeTruthy();
        }
      }
    });

    it('preserves system message through trim', () => {
      const tinyCtx = new ContextManager(200);
      tinyCtx.push(systemMsg('sys'));
      for (let i = 0; i < 10; i++) {
        tinyCtx.push(userMsg('x'.repeat(50)));
        tinyCtx.push(assistantMsg('y'.repeat(50)));
      }
      const msgs = tinyCtx.getMessages();
      expect(msgs[0].role).toBe('system');
      expect((msgs[0] as any).content).toBe('sys');
    });
  });
});
