import { readdir } from 'fs/promises';
import { join, resolve, relative } from 'path';
import type { Tool, ToolResult } from '../../types.js';

const MAX_ENTRIES = 500;
const CONCURRENCY = 20; // parallel directory reads
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.cache']);

export const listDirectoryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories in a path. Returns a tree-like structure. Shows up to 500 entries by default; use max_entries (up to 2000) for larger projects.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The directory path to list (defaults to current directory)',
          },
          depth: {
            type: 'number',
            description: 'Maximum depth to recurse (default: 2)',
          },
          max_entries: {
            type: 'number',
            description: 'Maximum number of entries to return (default: 500, max: 2000)',
          },
        },
        required: [],
      },
    },
  },

  async execute(args): Promise<ToolResult> {
    const dirPath = resolve((args.path as string | undefined) ?? '.');
    const maxDepth = (args.depth as number | undefined) ?? 2;
    const effectiveLimit = Math.min((args.max_entries as number | undefined) ?? MAX_ENTRIES, 2000);

    try {
      // Build a flat list of (depth, name, isDir) tuples using BFS with parallelism
      type Entry = { depth: number; name: string; isDir: boolean; relPath: string };
      const allEntries: Entry[] = [];

      // BFS queue: { absPath, depth, relPath }
      let queue: Array<{ absPath: string; depth: number; relPath: string }> = [
        { absPath: dirPath, depth: 0, relPath: '' },
      ];

      while (queue.length > 0 && allEntries.length < effectiveLimit * 2) {
        const batch = queue.splice(0, CONCURRENCY);
        const dirResults = await Promise.all(
          batch.map(async ({ absPath, depth, relPath }) => {
            if (depth > maxDepth) return [] as Entry[];
            let entries;
            try {
              entries = await readdir(absPath, { withFileTypes: true });
            } catch {
              return [] as Entry[];
            }
            const results: Entry[] = [];
            for (const e of entries) {
              if (depth === 0 && e.name.startsWith('.') && e.name !== '.') continue;
              // At depth > 0, skip dotfiles
              if (depth > 0 && e.name.startsWith('.')) continue;
              const childRel = relPath ? join(relPath, e.name) : e.name;
              if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) {
                  results.push({ depth, name: e.name, isDir: true, relPath: childRel + ' (skipped)' });
                } else {
                  results.push({ depth, name: e.name, isDir: true, relPath: childRel });
                }
              } else {
                results.push({ depth, name: e.name, isDir: false, relPath: childRel });
              }
            }
            return results;
          })
        );

        for (const entries of dirResults) {
          for (const entry of entries) {
            allEntries.push(entry);
            if (entry.isDir && !entry.relPath.endsWith('(skipped)') && entry.depth < maxDepth) {
              queue.push({
                absPath: join(dirPath, entry.relPath),
                depth: entry.depth + 1,
                relPath: entry.relPath,
              });
            }
          }
        }
      }

      // Build tree output: sort directories first, then alphabetically
      if (allEntries.length === 0) {
        return { success: true, output: '(empty directory)' };
      }

      // Group and sort: within each parent, dirs first then files, both alphabetically
      const lines: string[] = [];
      for (const entry of allEntries) {
        if (lines.length >= effectiveLimit) break;
        const indent = '  '.repeat(entry.depth);
        if (entry.isDir) {
          lines.push(`${indent}${entry.name}/`);
        } else {
          lines.push(`${indent}${entry.name}`);
        }
      }

      const truncated = allEntries.length > effectiveLimit;
      const output = lines.join('\n') +
        (truncated ? `\n… (${allEntries.length - effectiveLimit} more entries not shown)` : '');

      return { success: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Failed to list ${dirPath}: ${message}` };
    }
  },
};
