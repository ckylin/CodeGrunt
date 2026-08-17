import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { Tool, ToolResult } from '../../types.js';
import { findExactOrLineEndingTolerant, conformLineEndings } from '../../utils/line-endings.js';

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
    // The confirmation dialog reads the file, then waits (unbounded) for user
    // input before this executes. Re-read here rather than trusting the
    // pre-read snapshot in args._originalContent — if the file changed on disk
    // during that wait (external editor, another process), we must detect it
    // instead of silently overwriting the newer content.
    const preRead = args._originalContent as string | undefined;
    const current = existsSync(filePath) ? await readFile(filePath, 'utf-8') : '';
    if (preRead !== undefined && preRead !== current) {
      return {
        success: false,
        output: '',
        error: `File ${filePath} was modified on disk after the edit was confirmed. Re-read the file and retry the edit to avoid overwriting the newer content.`,
      };
    }
    const original = current;

    // Exact match first, falling back to a CRLF/LF-normalized match so a
    // Windows file with \r\n line endings still matches an old_string the
    // model reproduced with plain \n (see utils/line-endings.ts).
    const match = findExactOrLineEndingTolerant(original, oldString);
    if (match === null) {
      return {
        success: false,
        output: '',
        error: `old_string not found in ${filePath}. The string must match exactly including whitespace and indentation.`,
      };
    }
    if (match === 'AMBIGUOUS') {
      return {
        success: false,
        output: '',
        error: `old_string appears more than once in ${filePath}. Provide more surrounding context to make the match unique.`,
      };
    }

    const replacement = conformLineEndings(newString, match.matchedText);
    const updated = original.slice(0, match.start) + replacement + original.slice(match.end);
    await writeFile(filePath, updated, 'utf-8');
    // Diff already shown in confirmation dialog; here we just confirm success
    return { success: true, output: `Edited ${filePath}` , confirmDurationMs: (args._confirmDurationMs as number) ?? 0 };
  },
};
