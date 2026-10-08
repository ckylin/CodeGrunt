import { readFile, writeFile as fsWriteFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { Tool, ToolResult } from '../../types.js';
import { withFileMutationQueue } from './file-mutation-queue.js';
import { resolveToCwd } from './path-utils.js';

export const writeFileTool: Tool = {
  meta: { writesFiles: true, destructive: true },
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating parent directories if needed. Overwrites existing content. Use only for new files or complete rewrites; prefer edit_file for targeted changes.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to write',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const filePath = resolveToCwd(args.path as string, ctx?.cwd);
    const content = args.content as string;
    const confirmDurationMs = (args._confirmDurationMs as number | undefined) ?? 0;

    return withFileMutationQueue(filePath, async () => {
      try {
        if (ctx?.signal?.aborted) return { success: false, output: '', error: 'Operation aborted' };

        // The confirmation dialog reads the file, then waits (unbounded) for user
        // input before this executes. Re-read here rather than trusting the
        // pre-read snapshot: if the file changed on disk during that wait,
        // overwriting would silently destroy the newer content.
        const preRead = args._originalContent as string | undefined;
        if (preRead !== undefined) {
          const current = existsSync(filePath) ? await readFile(filePath, 'utf-8') : '';
          if (preRead !== current) {
            return {
              success: false,
              output: '',
              error: `File ${filePath} was modified on disk after the write was confirmed. Re-read the file and retry to avoid overwriting the newer content.`,
            };
          }
        }
        await mkdir(dirname(filePath), { recursive: true });
        await fsWriteFile(filePath, content, 'utf-8');
        return { success: true, output: `Wrote ${content.length} chars to ${filePath}`, confirmDurationMs };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: '', error: `Failed to write ${filePath}: ${message}` };
      }
    });
  },
};
