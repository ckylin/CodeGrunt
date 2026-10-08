import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeToolCall } from '../../src/core/pipeline/stages/process-tools-helpers.js';
import { getToolRegistry } from '../../src/core/tools/registry.js';
import type { Tool } from '../../src/types.js';

const THROWING_TOOL_NAME = '__test_throwing_tool__';

function makeThrowingTool(errorToThrow: unknown): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: THROWING_TOOL_NAME,
        description: 'test tool that always throws',
        parameters: { type: 'object', properties: {} },
      },
    },
    async execute() {
      throw errorToThrow;
    },
  };
}

describe('executeToolCall — tool execution error wrapping', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    getToolRegistry().unregister(THROWING_TOOL_NAME);
  });

  it('catches a thrown Error from tool.execute() and returns a graceful ToolResult (not a rejected promise)', async () => {
    getToolRegistry().register(makeThrowingTool(new Error('disk is full')), 'extension');
    const result = await executeToolCall(THROWING_TOOL_NAME, '{}');
    expect(result.success).toBe(false);
    expect(result.error).toContain(THROWING_TOOL_NAME);
    expect(result.error).toContain('disk is full');
  });

  it('handles a non-Error thrown value without crashing', async () => {
    getToolRegistry().register(makeThrowingTool('a raw string throw'), 'extension');
    const result = await executeToolCall(THROWING_TOOL_NAME, '{}');
    expect(result.success).toBe(false);
    expect(result.error).toContain('a raw string throw');
  });

  it('returns an error result for an unknown tool name instead of throwing', async () => {
    const result = await executeToolCall('does_not_exist', '{}');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });
});
