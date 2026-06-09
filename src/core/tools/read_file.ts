import { createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';
import { resolve } from 'path';
import type { Tool, ToolResult } from '../../types.js';

const MAX_BYTES = 100_000;
const LINE_RANGE_MAX_BYTES = 200_000;

function readFirstBytes(filePath: string, maxBytes: number): Promise<{ buf: Buffer; totalSize: number }> {
  return new Promise((res, rej) => {
    let totalSize = 0;
    try { totalSize = statSync(filePath).size; } catch { /* ignore */ }

    const chunks: Buffer[] = [];
    let collected = 0;
    const stream = createReadStream(filePath, { highWaterMark: 65536 });

    stream.on('data', (chunk: Buffer | string) => {
      const data: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const remaining = maxBytes - collected;
      if (remaining <= 0) { stream.destroy(); return; }
      const slice = data.length <= remaining ? data : data.subarray(0, remaining);
      chunks.push(slice);
      collected += slice.length;
      if (collected >= maxBytes) stream.destroy();
    });

    stream.on('close', () => res({ buf: Buffer.concat(chunks), totalSize }));
    stream.on('error', rej);
  });
}

/** Count all lines in a file by streaming (no content loaded). */
function countLines(filePath: string): Promise<number> {
  return new Promise((res, rej) => {
    let lineNo = 0;
    const stream = createReadStream(filePath, { highWaterMark: 65536 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', () => { lineNo++; });
    rl.on('close', () => res(lineNo));
    stream.on('error', rej);
  });
}

/** Read lines [startLine .. endLine] (1-indexed, inclusive) by streaming, stopping after endLine. */
function readLinesStreaming(filePath: string, startLine: number, endLine: number): Promise<{ lines: string[]; totalLines: number }> {
  return new Promise((res, rej) => {
    const selectedLines: string[] = [];
    let lineNo = 0;

    const stream = createReadStream(filePath, { highWaterMark: 65536 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      lineNo++;
      if (lineNo >= startLine && lineNo <= endLine) {
        selectedLines.push(line);
      }
      if (lineNo >= endLine) {
        rl.close();
        stream.destroy();
      }
    });

    rl.on('close', () => res({ lines: selectedLines, totalLines: lineNo }));
    stream.on('error', rej);
  });
}

export const readFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the contents of a file. Returns the file content as a string. ' +
        'Large files (>100KB) without a line range return a line-count summary instead of content — use start_line/end_line to read specific sections. ' +
        'Use start_line and end_line (1-indexed, inclusive) to read a specific range of lines.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to read (absolute or relative to cwd)',
          },
          start_line: {
            type: 'number',
            description: 'First line to return (1-indexed, inclusive). Requires end_line.',
          },
          end_line: {
            type: 'number',
            description: 'Last line to return (1-indexed, inclusive). Requires start_line.',
          },
        },
        required: ['path'],
      },
    },
  },

  async execute(args): Promise<ToolResult> {
    const filePath = resolve(args.path as string);
    const startLine = args.start_line as number | undefined;
    const endLine = args.end_line as number | undefined;

    const hasRange = startLine !== undefined && endLine !== undefined;

    try {
      let totalSize = 0;
      try { totalSize = statSync(filePath).size; } catch { /* will surface below */ }

      // ── Line-range path ──
      if (hasRange) {
        const start = Math.max(1, startLine!);
        const end = Math.max(start, endLine!);

        if (totalSize > LINE_RANGE_MAX_BYTES) {
          // Large file: stream lines until end_line reached
          const { lines, totalLines } = await readLinesStreaming(filePath, start, end);
          const header = `[Lines ${start}-${Math.min(end, totalLines)} of ${totalLines}+ total (file >200KB, streamed)]\n`;
          return { success: true, output: header + lines.join('\n') };
        } else {
          // Small enough to load fully
          const { buf, totalSize: size } = await readFirstBytes(filePath, LINE_RANGE_MAX_BYTES);
          const allLines = buf.toString('utf-8').split('\n');
          const totalLines = allLines.length;
          const sliced = allLines.slice(start - 1, end);
          const actualEnd = Math.min(end, totalLines);
          const header = `[Lines ${start}-${actualEnd} of ${totalLines} total]\n`;
          return { success: true, output: header + sliced.join('\n') };
        }
      }

      // ── No line range: standard byte-read path ──
      if (totalSize > LINE_RANGE_MAX_BYTES) {
        // File too large to load even partially — count lines by streaming
        const totalLines = await countLines(filePath);
        const kb = Math.round(totalSize / 1024);
        return {
          success: true,
          output: `[File has ${totalLines} lines (~${kb} KB). Use start_line/end_line to read specific sections.]`,
        };
      }

      const { buf, totalSize: size } = await readFirstBytes(filePath, MAX_BYTES);
      const content = buf.toString('utf-8');
      if (size > MAX_BYTES) {
        return {
          success: true,
          output: content + `\n\n[File truncated — ${size} total bytes, showing first ${MAX_BYTES}]`,
        };
      }
      return { success: true, output: content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Failed to read ${filePath}: ${message}` };
    }
  },
};
