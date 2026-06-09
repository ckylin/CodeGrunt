import { randomUUID } from 'node:crypto';
import {
  writeEntry, readEntries,
  type MemoryEntry, type MemoryEntryType,
} from '../memory/store.js';
import type { Tool, ToolResult } from '../../types.js';

// ── memory_write ──────────────────────────────────────────────────────────────

export const memoryWriteTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_write',
      description: 'Store a persistent fact in memory. Facts survive across sessions. Use for user preferences, project-specific decisions, reference snippets, or feedback you should remember.',
      parameters: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: 'Short identifier (e.g. "user_prefers_tabs")' },
          type:        { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'user=preferences, feedback=corrections, project=project facts, reference=code/doc snippets' },
          description: { type: 'string', description: 'One-line summary of this entry' },
          body:        { type: 'string', description: 'The content to store' },
          id:          { type: 'string', description: 'Existing entry id to update instead of creating new' },
        },
        required: ['name', 'type', 'description', 'body'],
      },
    },
  },

  async execute(args): Promise<ToolResult> {
    const now = new Date().toISOString();
    // Preserve original createdAt when updating an existing entry by id.
    const existingId = args.id as string | undefined;
    let createdAt = now;
    if (existingId) {
      const existing = (await readEntries()).find(e => e.id === existingId);
      if (existing) createdAt = existing.createdAt;
    }
    const entry: MemoryEntry = {
      id:          existingId ?? randomUUID().slice(0, 8),
      type:        args.type as MemoryEntryType,
      name:        args.name as string,
      description: args.description as string,
      body:        args.body as string,
      createdAt,
      updatedAt:   now,
    };
    try {
      await writeEntry(entry);
      return { success: true, output: `Memory saved: ${entry.name} (id: ${entry.id})` };
    } catch (err) {
      return { success: false, output: '', error: `Failed to write memory: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

// ── memory_read ───────────────────────────────────────────────────────────────

export const memoryReadTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_read',
      description: 'Read persistent facts from memory. Omit type to read all entries, or filter by category.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Filter by type. Omit to read all.' },
        },
        required: [],
      },
    },
  },

  async execute(args): Promise<ToolResult> {
    try {
      const entries = await readEntries(args.type as MemoryEntryType | undefined);
      if (entries.length === 0) return { success: true, output: 'No memory entries found.' };
      const formatted = entries
        .map(e => `[${e.id}] (${e.type}) ${e.name}: ${e.description}\n${e.body}`)
        .join('\n\n---\n\n');
      return { success: true, output: formatted };
    } catch (err) {
      return { success: false, output: '', error: `Failed to read memory: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
