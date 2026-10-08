import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { Tool, ToolResult } from '../../types.js';
import { applyEditToContent } from './edit-diff.js';
import { withFileMutationQueue } from './file-mutation-queue.js';
import { resolveToCwd } from './path-utils.js';

export const editFileTool: Tool = {
  meta: { writesFiles: true, destructive: true },
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace one exact string in a file with new content. old_string must be unique in the file; include enough surrounding context to make it so, but keep it as small as possible. ' +
        'Matching tolerates CRLF/LF differences, trailing whitespace, and smart quotes/unicode dashes, but not other differences. Fails clearly if old_string is not found or appears more than once.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'The exact string to find and replace (must be unique in the file)',
          },
          new_string: {
            type: 'string',
            description: 'The string to replace it with',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const filePath = resolveToCwd(args.path as string, ctx?.cwd);
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const confirmDurationMs = (args._confirmDurationMs as number | undefined) ?? 0;

    if (oldString.length === 0) {
      return { success: false, output: '', error: 'old_string must not be empty. Use write_file to create or overwrite a file.' };
    }

    return withFileMutationQueue(filePath, async () => {
      if (ctx?.signal?.aborted) return { success: false, output: '', error: 'Operation aborted' };

      // The confirmation dialog reads the file, then waits (unbounded) for user
      // input before this executes. Compare against the pre-read snapshot so an
      // external change during that wait is detected instead of overwritten.
      const preRead = args._originalContent as string | undefined;
      const current = existsSync(filePath) ? await readFile(filePath, 'utf-8') : '';
      if (preRead !== undefined && preRead !== current) {
        return {
          success: false,
          output: '',
          error: `File ${filePath} was modified on disk after the edit was confirmed. Re-read the file and retry the edit to avoid overwriting the newer content.`,
        };
      }

      const applied = applyEditToContent(current, oldString, newString);
      if (applied === null) {
        return {
          success: false,
          output: '',
          error: `old_string not found in ${filePath}. The string must match exactly including whitespace and indentation.`,
        };
      }
      if (applied === 'AMBIGUOUS') {
        return {
          success: false,
          output: '',
          error: `old_string appears more than once in ${filePath}. Provide more surrounding context to make the match unique.`,
        };
      }
      if (applied.content === current) {
        return { success: false, output: '', error: `No changes made to ${filePath}: the replacement produced identical content.` };
      }

      await writeFile(filePath, applied.content, 'utf-8');
      const note = applied.fuzzy ? ' (matched ignoring whitespace/quote differences)' : '';
      return { success: true, output: `Edited ${filePath}${note}`, confirmDurationMs };
    });
  },
};
