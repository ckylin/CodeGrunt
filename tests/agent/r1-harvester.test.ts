import { describe, it, expect } from 'vitest';
import { harvestToolCalls, deduplicateHarvested, filterNonEscaped } from '../../src/core/agent/r1-harvester.js';

describe('R1 Thought Harvesting', () => {
  describe('harvestToolCalls', () => {
    it('extracts a tool call from reasoning content', () => {
      const reasoning = 'I need to read the file first. read_file({ "path": "src/index.ts" })';
      const result = harvestToolCalls(reasoning);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read_file');
      expect(result[0].args.path).toBe('src/index.ts');
      expect(result[0].confidence).toBe(0.9);
    });

    it('extracts multiple tool calls', () => {
      const reasoning = `
        First, I'll read the config: read_file({ "path": "config.json" })
        Then search for auth: search_files({ "pattern": "auth" })
      `;
      const result = harvestToolCalls(reasoning);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('returns empty array for empty reasoning content', () => {
      expect(harvestToolCalls('')).toHaveLength(0);
      expect(harvestToolCalls('  ')).toHaveLength(0);
    });

    it('returns empty array for reasoning with no tool calls', () => {
      const reasoning = 'I need to think about this carefully. The approach is clear.';
      expect(harvestToolCalls(reasoning)).toHaveLength(0);
    });

    it('ignores non-tool names in reasoning', () => {
      const reasoning = 'The function calculateTotal({ "x": 1 }) should work.';
      expect(harvestToolCalls(reasoning)).toHaveLength(0);
    });

    it('handles tool calls with "use" prefix', () => {
      const reasoning = 'I should use read_file({ "path": "package.json" })';
      const result = harvestToolCalls(reasoning);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read_file');
    });

    it('handles tool calls with "call" prefix', () => {
      const reasoning = 'Let me call search_files({ "pattern": "router" })';
      const result = harvestToolCalls(reasoning);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('search_files');
    });

    it('repairs malformed JSON in reasoning', () => {
      const reasoning = 'read_file({ path: "src/index.ts" })'; // unquoted key
      const result = harvestToolCalls(reasoning);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read_file');
      expect(result[0].args.path).toBe('src/index.ts');
    });

    it('returns lower confidence for incomplete args', () => {
      const reasoning = 'execute_shell({})'; // missing required 'command' param
      const result = harvestToolCalls(reasoning);
      expect(result).toHaveLength(1);
      expect(result[0].confidence).toBe(0.5);
    });

    it('extracts execute_shell calls', () => {
      const reasoning = 'execute_shell({ "command": "npm test" })';
      const result = harvestToolCalls(reasoning);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('execute_shell');
      expect(result[0].args.command).toBe('npm test');
    });

    it('extracts web_search calls', () => {
      const reasoning = 'I should search the web: web_search({ "query": "typescript decorators" })';
      const result = harvestToolCalls(reasoning);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('web_search');
      expect(result[0].args.query).toBe('typescript decorators');
    });
  });

  describe('deduplicateHarvested', () => {
    it('removes duplicate tool calls for the same file', () => {
      const calls = [
        { name: 'read_file', args: { path: 'src/index.ts' }, raw: '', confidence: 0.9 },
        { name: 'read_file', args: { path: 'src/index.ts' }, raw: '', confidence: 0.5 },
      ];
      const result = deduplicateHarvested(calls);
      expect(result).toHaveLength(1);
      expect(result[0].confidence).toBe(0.9);
    });

    it('keeps different tool calls separate', () => {
      const calls = [
        { name: 'read_file', args: { path: 'a.ts' }, raw: '', confidence: 0.9 },
        { name: 'read_file', args: { path: 'b.ts' }, raw: '', confidence: 0.9 },
      ];
      const result = deduplicateHarvested(calls);
      expect(result).toHaveLength(2);
    });
  });

  describe('filterNonEscaped', () => {
    it('filters out tool calls that were already emitted', () => {
      const harvested = [
        { name: 'read_file', args: { path: 'a.ts' }, raw: '', confidence: 0.9 },
        { name: 'read_file', args: { path: 'b.ts' }, raw: '', confidence: 0.9 },
      ];
      const actual = [{ name: 'read_file', args: '{"path": "a.ts"}' }];
      const result = filterNonEscaped(harvested, actual);
      expect(result).toHaveLength(1);
      expect(result[0].args.path).toBe('b.ts');
    });

    it('returns all harvested when no actual tool calls', () => {
      const harvested = [
        { name: 'read_file', args: { path: 'a.ts' }, raw: '', confidence: 0.9 },
      ];
      expect(filterNonEscaped(harvested, [])).toHaveLength(1);
    });
  });
});
