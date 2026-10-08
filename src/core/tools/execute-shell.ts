import { spawn, spawnSync } from 'child_process';
import { platform } from 'os';
import type { Tool, ToolResult } from '../../types.js';
import { OutputAccumulator, type OutputSnapshot } from './output-accumulator.js';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from './truncate.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000; // 5 minutes hard cap
const IS_WINDOWS = platform() === 'win32';

// The LLM frequently generates commands for the wrong OS. Embedding the exact
// platform and concrete syntax in the tool description (which the model reads
// right before generating the call) cuts cross-platform command errors.
function buildShellDescription(): string {
  const base =
    'Execute a shell command and return its output. The working directory is already set to the project root; do NOT prepend "cd <path> &&" to commands. ' +
    'Use for running tests, builds, installing packages, git commands, etc. Timeout: default 30s, max 5 minutes. ' +
    `Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; when truncated, the full output is saved to a temp file and its path is reported.`;

  if (IS_WINDOWS) {
    return `${base}

WARNING: YOU ARE ON WINDOWS. Commands run in cmd.exe. You MUST use Windows syntax:
- Use backslashes in paths: C:\\Users\\... not /home/...
- List files: dir not ls
- Remove file: del not rm
- Remove directory: rmdir /s not rm -rf
- Copy: copy not cp
- Move: move not mv
- Print to stdout: echo %VAR% not echo $VAR
- Set env: set VAR=value not export VAR=value
- Chain commands with && (same as Unix)
- npm/npx/node work the same as on Unix, prefer them when possible`;
  }

  return `${base}

You are on ${platform() === 'darwin' ? 'macOS' : 'Linux'}. Use POSIX shell syntax:
- Use forward slashes in paths: /home/user/...
- List files: ls -la
- Remove: rm -rf
- Copy: cp -r
- Move: mv
- Print: echo $VAR
- Set env: export VAR=value
- Chain commands with &&
- npm/npx/node work as usual`;
}

/** Kill the shell and everything it spawned, not just the shell itself. */
function killProcessTree(pid: number): void {
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function withTruncationNotice(snap: OutputSnapshot): string {
  const t = snap.truncation;
  let text = snap.content;
  if (!t.truncated) return text;
  const full = snap.fullOutputPath ? ` Full output: ${snap.fullOutputPath}` : '';
  if (t.lastLinePartial) {
    text += `\n\n[Showing the last ${formatSize(t.outputBytes)} of line ${t.totalLines}.${full}]`;
  } else if (t.truncatedBy === 'lines') {
    text += `\n\n[Output truncated: showing last ${t.outputLines} of ${t.totalLines} lines.${full}]`;
  } else {
    text += `\n\n[Output truncated: showing last ${t.outputLines} of ${t.totalLines} lines (${formatSize(DEFAULT_MAX_BYTES)} limit).${full}]`;
  }
  return text;
}

export const executeShellTool: Tool = {
  meta: { destructive: true },
  definition: {
    type: 'function',
    function: {
      name: 'execute_shell',
      description: buildShellDescription(),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: {
            type: 'string',
            description: 'Working directory for the command (optional, defaults to current directory)',
          },
          timeout_ms: {
            type: 'number',
            description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})`,
          },
        },
        required: ['command'],
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const command = args.command as string;
    const cwd = (args.cwd as string | undefined) ?? ctx?.cwd ?? process.cwd();
    const rawTimeout = (args.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS;
    const clamped = rawTimeout > MAX_TIMEOUT_MS;
    const timeoutMs = clamped ? MAX_TIMEOUT_MS : rawTimeout;
    const confirmDurationMs = (args._confirmDurationMs as number | undefined) ?? 0;
    const signal = ctx?.signal;

    if (signal?.aborted) return { success: false, output: '', error: 'Command aborted', confirmDurationMs };

    return new Promise((resolve) => {
      const out = new OutputAccumulator();
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const child = spawn(command, {
        shell: true,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !IS_WINDOWS,
        windowsHide: true,
      });

      const stop = (): void => { if (child.pid) killProcessTree(child.pid); };
      const onAbort = (): void => { aborted = true; stop(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };

      child.stdout.on('data', (d: Buffer) => out.append(d));
      child.stderr.on('data', (d: Buffer) => out.append(d));

      child.on('close', async (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        out.finish();
        const snap = out.snapshot();
        await out.closeTempFile();
        let text = withTruncationNotice(snap);
        if (clamped) text += '\n[timeout clamped to 5min]';
        if (aborted) {
          resolve({ success: false, output: text, error: 'Command aborted', confirmDurationMs });
        } else if (timedOut) {
          resolve({ success: false, output: text, error: `Command timed out after ${timeoutMs}ms (captured ${snap.truncation.totalBytes} bytes)`, confirmDurationMs });
        } else if (code !== 0) {
          const why = code === null ? 'Command terminated by a signal' : `Command exited with code ${code}`;
          resolve({ success: false, output: text, error: why, confirmDurationMs });
        } else {
          resolve({ success: true, output: text || '(no output)', confirmDurationMs });
        }
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ success: false, output: '', error: err.message, confirmDurationMs });
      });
    });
  },
};
