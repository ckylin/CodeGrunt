import { createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';
import type { Tool, ToolResult } from '../../types.js';
import { resolveToCwd } from './path-utils.js';
import { formatSize } from './truncate.js';

const MAX_LINES = 2000;
const MAX_BYTES = 100_000;
// Past this size we stop scanning once the window is full instead of counting every line.
const COUNT_ALL_MAX_BYTES = 2 * 1024 * 1024;

interface ReadWindow {
  lines: string[];
  stoppedBy: 'eof' | 'end_line' | 'lines' | 'bytes';
  totalLines?: number;
  clippedLineBytes?: number;
}

function clipToBytes(line: string, maxBytes: number): string {
  const clipped = Buffer.from(line, 'utf-8').subarray(0, maxBytes).toString('utf-8');
  // A cut inside a multi-byte character decodes to a trailing U+FFFD; drop it.
  return clipped.charCodeAt(clipped.length - 1) === 0xfffd ? clipped.slice(0, -1) : clipped;
}

/** Stream lines [start..end], stopping at the line/byte limits. Never loads the whole file. */
function readWindow(filePath: string, start: number, end: number, countAll: boolean): Promise<ReadWindow> {
  return new Promise((res, rej) => {
    const stream = createReadStream(filePath, { highWaterMark: 65536 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const lines: string[] = [];
    let lineNo = 0;
    let bytes = 0;
    let stopped = false;
    let stoppedBy: ReadWindow['stoppedBy'] = 'eof';
    let clippedLineBytes: number | undefined;

    rl.on('line', (line) => {
      lineNo++;
      if (stopped || lineNo < start) return;
      if (lineNo > end) {
        stopped = true;
        stoppedBy = 'end_line';
      } else if (lines.length >= MAX_LINES) {
        stopped = true;
        stoppedBy = 'lines';
      } else {
        const lineBytes = Buffer.byteLength(line, 'utf-8');
        if (bytes + lineBytes + (lines.length > 0 ? 1 : 0) > MAX_BYTES) {
          if (lines.length === 0) {
            lines.push(clipToBytes(line, MAX_BYTES));
            clippedLineBytes = lineBytes;
          }
          stopped = true;
          stoppedBy = 'bytes';
        } else {
          lines.push(line);
          bytes += lineBytes + (lines.length > 1 ? 1 : 0);
        }
      }
      if (stopped && !countAll) {
        rl.close();
        stream.destroy();
      }
    });

    rl.on('close', () => {
      const totalKnown = !stopped || countAll;
      res({ lines, stoppedBy, totalLines: totalKnown ? lineNo : undefined, clippedLineBytes });
    });
    stream.on('error', rej);
  });
}

export const readFileTool: Tool = {
  meta: { readsFiles: true, subagentSafe: true },
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        `Read the contents of a file. Output is limited to ${MAX_LINES} lines or ${formatSize(MAX_BYTES)} (whichever is hit first); ` +
        'when a file is cut off, the result ends with the exact start_line to continue from. ' +
        'Use start_line and end_line (1-indexed, inclusive) to read a specific range; either may be given alone.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to read (absolute or relative to cwd)',
          },
          start_line: {
            type: 'number',
            description: 'First line to return (1-indexed, inclusive). Defaults to 1.',
          },
          end_line: {
            type: 'number',
            description: 'Last line to return (1-indexed, inclusive). Defaults to the end of the file (subject to output limits).',
          },
        },
        required: ['path'],
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const filePath = resolveToCwd(args.path as string, ctx?.cwd);
    const startArg = args.start_line as number | undefined;
    const endArg = args.end_line as number | undefined;
    const hasRange = startArg !== undefined || endArg !== undefined;

    try {
      const size = statSync(filePath).size;
      const start = Math.max(1, Math.floor(startArg ?? 1));
      const end = endArg === undefined ? Infinity : Math.max(start, Math.floor(endArg));
      const w = await readWindow(filePath, start, end, size <= COUNT_ALL_MAX_BYTES);
      const total = w.totalLines;

      if (w.lines.length === 0 && start > 1 && total !== undefined && start > total) {
        return { success: false, output: '', error: `start_line ${start} is beyond the end of ${filePath} (${total} lines total)` };
      }

      const last = start + w.lines.length - 1;
      let out = w.lines.join('\n');
      if (hasRange && w.lines.length > 0) {
        out = `[Lines ${start}-${last}${total !== undefined ? ` of ${total} total` : ''}]\n${out}`;
      }

      if (w.clippedLineBytes !== undefined) {
        out += `\n\n[Line ${start} is ${formatSize(w.clippedLineBytes)}, exceeds the ${formatSize(MAX_BYTES)} limit; output was truncated to the first ${formatSize(MAX_BYTES)} of that line. Use start_line=${start + 1} to continue after it.]`;
      } else if (w.stoppedBy === 'lines' || w.stoppedBy === 'bytes') {
        const limit = w.stoppedBy === 'bytes' ? ` (${formatSize(MAX_BYTES)} limit)` : '';
        out += `\n\n[Output truncated: showing lines ${start}-${last}${total !== undefined ? ` of ${total}` : ''}${limit}. Use start_line=${last + 1} to continue.]`;
      }
      return { success: true, output: out };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Failed to read ${filePath}: ${message}` };
    }
  },
};
