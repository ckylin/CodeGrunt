import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { Tool, ToolResult } from '../../types.js';
import { resolveToCwd } from './path-utils.js';
import { SKIP_DIRS_DEFAULT as SKIP_DIRS } from '../../utils/fs-ignore.js';

const MAX_ENTRIES = 500;
const HARD_MAX_ENTRIES = 2000;

function byName(a: { name: string; isDirectory(): boolean }, b: { name: string; isDirectory(): boolean }): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

export const listDirectoryTool: Tool = {
  meta: { readsFiles: true, subagentSafe: true },
  definition: {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        'List files and directories in a path as an indented tree (directories first, then files, alphabetical; dotfiles hidden). ' +
        `Shows up to ${MAX_ENTRIES} entries by default; use max_entries (up to ${HARD_MAX_ENTRIES}) for larger projects. Directories like node_modules and .git are listed but not expanded.`,
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
            description: `Maximum number of entries to return (default: ${MAX_ENTRIES}, max: ${HARD_MAX_ENTRIES})`,
          },
        },
        required: [],
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const dirPath = resolveToCwd((args.path as string | undefined) ?? '.', ctx?.cwd);
    const maxDepth = (args.depth as number | undefined) ?? 2;
    const limit = Math.min((args.max_entries as number | undefined) ?? MAX_ENTRIES, HARD_MAX_ENTRIES);

    try {
      let info;
      try {
        info = await stat(dirPath);
      } catch {
        return { success: false, output: '', error: `Path not found: ${dirPath}` };
      }
      if (!info.isDirectory()) return { success: false, output: '', error: `Not a directory: ${dirPath}` };

      const lines: string[] = [];
      let total = 0;

      const walk = async (abs: string, depth: number): Promise<void> => {
        if (ctx?.signal?.aborted) return;
        let entries;
        try {
          entries = await readdir(abs, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort(byName);
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          total++;
          const skipped = e.isDirectory() && SKIP_DIRS.has(e.name);
          if (lines.length < limit) {
            const label = e.isDirectory() ? `${e.name}/${skipped ? ' (skipped)' : ''}` : e.name;
            lines.push('  '.repeat(depth) + label);
          }
          if (e.isDirectory() && !skipped && depth < maxDepth) await walk(join(abs, e.name), depth + 1);
        }
      };
      await walk(dirPath, 0);

      if (total === 0) return { success: true, output: '(empty directory)' };
      const hidden = total - lines.length;
      const notice = hidden > 0 ? `\n[${hidden} more entries not shown. Use max_entries=${Math.min(limit * 2, HARD_MAX_ENTRIES)} or a smaller depth/path.]` : '';
      return { success: true, output: lines.join('\n') + notice };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Failed to list ${dirPath}: ${message}` };
    }
  },
};
