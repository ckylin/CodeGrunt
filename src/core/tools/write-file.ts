import { readFile, writeFile as fsWriteFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import type { Tool, ToolResult } from '../../types.js';

export const writeFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating parent directories if needed. Overwrites existing content.',
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

  async execute(args): Promise<ToolResult> {
    const filePath = resolve(args.path as string);
    const content = args.content as string;
    try {
      // The confirmation dialog reads the file, then waits (unbounded) for user
      // input before this executes. Re-read here rather than trusting the
      // pre-read snapshot in args._originalContent — if the file changed on disk
      // during that wait (external editor, another process), overwrite would
      // silently destroy the newer content.
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
      // Diff already shown in confirmation dialog; here we just confirm success
      return { success: true, output: `Wrote ${content.length} chars to ${filePath}` , confirmDurationMs: (args._confirmDurationMs as number) ?? 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Failed to write ${filePath}: ${message}` };
    }
  },
};
