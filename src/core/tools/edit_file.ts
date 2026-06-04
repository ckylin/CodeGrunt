import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { Tool, ToolResult } from '../../types.js';

export const editFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact string in a file with new content. The old_string must match exactly (including whitespace). Fails clearly if old_string is not found.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'The exact string to find and replace',
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

  async execute(args): Promise<ToolResult> {
    const filePath = resolve(args.path as string);
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    // Use pre-read content from executor if available (avoids double read)
    const original = (args._originalContent as string | undefined) ?? await readFile(filePath, 'utf-8');

    if (!original.includes(oldString)) {
      return {
        success: false,
        output: '',
        error: `old_string not found in ${filePath}. The string must match exactly including whitespace and indentation.`,
      };
    }

    // Reject ambiguous edits — old_string must appear exactly once.
    // Ref: utils/confirm.ts applyEdit for the same guard in the confirm path.
    const firstIdx = original.indexOf(oldString);
    const lastIdx = original.lastIndexOf(oldString);
    if (firstIdx !== lastIdx) {
      return {
        success: false,
        output: '',
        error: `old_string appears more than once in ${filePath}. Provide more surrounding context to make the match unique.`,
      };
    }

    const updated = original.slice(0, firstIdx) + newString + original.slice(firstIdx + oldString.length);
    await writeFile(filePath, updated, 'utf-8');
    // Diff already shown in confirmation dialog; here we just confirm success
    return { success: true, output: `Edited ${filePath}` , confirmDurationMs: (args._confirmDurationMs as number) ?? 0 };
  },
};
