import { spawn } from 'child_process';
import type { Tool, ToolResult } from '../../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000; // 5 minutes hard cap
const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB cap to avoid huge outputs stalling the LLM

export const executeShellTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'execute_shell',
      description: 'Execute a shell command and return its output. The working directory is already set to the project root — do NOT prepend "cd <path> &&" to commands. Use for running tests, builds, installing packages, git commands, etc. Timeout: default 30s, max 5 minutes.',
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

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // SIGKILL fallback if SIGTERM doesn't work within 2s
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 2000);
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        let output = Buffer.concat(chunks).toString('utf-8');
        if (truncated) output += `\n[Output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
        if (clamped) output += `\n[timeout clamped to 5min]`;
        if (timedOut) {
          resolve({ success: false, output, error: `Command timed out after ${timeoutMs}ms (captured ${totalBytes} bytes)` });
        } else if (code !== 0) {
          resolve({ success: false, output, error: `Command exited with code ${code}` });
        } else {
          resolve({ success: true, output: output || '(no output)' });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ success: false, output: '', error: err.message });
      });
    });
  },
};
