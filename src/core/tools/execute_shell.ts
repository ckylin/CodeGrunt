import { spawn } from 'child_process';
import { platform } from 'os';
import type { Tool, ToolResult } from '../../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000; // 5 minutes hard cap
const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB cap to avoid huge outputs stalling the LLM

// ── Platform-aware tool description ──────────────────────────────────────
// The LLM frequently generates commands for the wrong OS. By embedding the
// exact platform and concrete syntax examples directly into the tool
// description (which the model reads right before generating the function
// call), we dramatically reduce cross-platform command errors.

function buildShellDescription(): string {
  const base = 'Execute a shell command and return its output. The working directory is already set to the project root — do NOT prepend "cd <path> &&" to commands. Use for running tests, builds, installing packages, git commands, etc. Timeout: default 30s, max 5 minutes.';

  if (platform() === 'win32') {
    return `${base}

⚠️  YOU ARE ON WINDOWS. Commands run in cmd.exe. You MUST use Windows syntax:
- Use backslashes in paths: C:\\Users\\... not /home/...
- List files: dir not ls
- Remove file: del not rm
- Remove directory: rmdir /s not rm -rf
- Copy: copy not cp
- Move: move not mv
- Print to stdout: echo %VAR% not echo $VAR
- Set env: set VAR=value not export VAR=value
- Chain commands with && (same as Unix)
- npm/npx/node work the same as on Unix — prefer them when possible`;
  }

  // macOS or Linux — POSIX
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

export const executeShellTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'execute_shell',
      description: buildShellDescription(),
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the command (optional, defaults to current directory)',
          },
          timeout_ms: {
            type: 'number',
            description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
          },
        },
        required: ['command'],
      },
    },
  },

  async execute(args): Promise<ToolResult> {
    const command = args.command as string;
    const cwd = (args.cwd as string | undefined) ?? process.cwd();
    const rawTimeout = (args.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS;
    const clamped = rawTimeout > MAX_TIMEOUT_MS;
    const timeoutMs = clamped ? MAX_TIMEOUT_MS : rawTimeout;

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let truncated = false;
      let timedOut = false;

      const child = spawn(command, {
        shell: true,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const onData = (data: Buffer): void => {
        if (truncated) return;
        const remaining = MAX_OUTPUT_BYTES - totalBytes;
        if (data.length <= remaining) {
          chunks.push(data);
          totalBytes += data.length;
        } else {
          chunks.push(data.subarray(0, remaining));
          totalBytes += remaining;
          truncated = true;
        }
      };

      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      // SIGKILL fallback timer — tracked separately so it can be cleared if the
      // child exits on its own after SIGTERM but before the 2s fallback fires.
      // Without clearing it, the Node event loop hangs an extra 2s after every
      // timed-out command, even ones that terminate cleanly.
      let killTimer: NodeJS.Timeout | undefined;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 2000);
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        let output = Buffer.concat(chunks).toString('utf-8');
        if (truncated) output += `\n[Output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
        if (clamped) output += `\n[timeout clamped to 5min]`;
        const confirmDurationMs = (args._confirmDurationMs as number | undefined) ?? 0;
        if (timedOut) {
          resolve({ success: false, output, error: `Command timed out after ${timeoutMs}ms (captured ${totalBytes} bytes)`, confirmDurationMs });
        } else if (code !== 0) {
          resolve({ success: false, output, error: `Command exited with code ${code}`, confirmDurationMs });
        } else {
          resolve({ success: true, output: output || '(no output)', confirmDurationMs });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ success: false, output: '', error: err.message, confirmDurationMs: (args._confirmDurationMs as number | undefined) ?? 0 });
      });
    });
  },
};
