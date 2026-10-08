import { describe, it, expect } from 'vitest';
import { getToolRegistry, toolHasTrait, toolNamesWithTrait } from '../../src/core/tools/registry.js';
import { getToolSchema } from '../../src/core/tools/args-repair.js';
import { getSubagentToolNames } from '../../src/core/agent/subagent.js';
import { getWorkerWriteToolNames, getWriterAllowlist } from '../../src/core/agent/worker.js';

// These sets used to be hand-maintained name lists scattered across the code.
// Pinning them here guarantees the declarative `meta` flags describe exactly
// the same tools.

describe('tool meta traits', () => {
  it('sub-agents get exactly the read-only research tools', () => {
    expect([...getSubagentToolNames()].sort()).toEqual(
      ['code_search', 'list_directory', 'memory_read', 'read_file', 'search_files', 'web_search'],
    );
  });

  it('file writers are write_file and edit_file only (never the shell)', () => {
    expect([...getWorkerWriteToolNames()].sort()).toEqual(['edit_file', 'write_file']);
    expect(getWorkerWriteToolNames().has('execute_shell')).toBe(false);
  });

  it('a writer worker may use the research tools plus the file writers', () => {
    expect([...getWriterAllowlist()].sort()).toEqual(
      ['code_search', 'edit_file', 'list_directory', 'memory_read', 'read_file', 'search_files', 'web_search', 'write_file'],
    );
  });

  it('file readers (for blind-write detection) are read_file, search_files, list_directory', () => {
    expect([...toolNamesWithTrait('readsFiles')].sort()).toEqual(['list_directory', 'read_file', 'search_files']);
  });

  it('destructive tools are the file writers and the shell', () => {
    expect([...toolNamesWithTrait('destructive')].sort()).toEqual(['edit_file', 'execute_shell', 'write_file']);
  });

  it('a tool registered without meta has no traits', () => {
    const registry = getToolRegistry();
    registry.register({
      definition: { type: 'function', function: { name: '__no_meta__', description: '', parameters: { type: 'object', properties: {} } } },
      async execute() { return { success: true, output: '' }; },
    });
    try {
      expect(toolHasTrait('__no_meta__', 'destructive')).toBe(false);
      expect(toolHasTrait('__no_meta__', 'subagentSafe')).toBe(false);
      expect(toolHasTrait('does_not_exist', 'destructive')).toBe(false);
    } finally {
      registry.unregister('__no_meta__');
    }
  });
});

describe('required parameters come from each tool schema', () => {
  const required = (name: string) => getToolSchema(name)?.required;

  it('keeps the parameters the old hardcoded table demanded', () => {
    expect(required('read_file')).toEqual(['path']);
    expect(required('write_file')).toEqual(['path', 'content']);
    expect(required('edit_file')).toEqual(['path', 'old_string', 'new_string']);
    expect(required('execute_shell')).toEqual(['command']);
    expect(required('search_files')).toEqual(['pattern']);
    expect(required('agent_open')).toEqual(['task']);
  });

  it('returns null for an unknown tool', () => {
    expect(getToolSchema('does_not_exist')).toBeNull();
  });
});
