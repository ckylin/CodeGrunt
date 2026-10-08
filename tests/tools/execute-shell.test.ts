import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeShellTool } from '../../src/core/tools/execute_shell.js';

describe('execute_shell', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `codegrunt-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a simple command', async () => {
    const result = await executeShellTool.execute({ command: 'echo hello' });
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe('hello');
  });

  it('captures non-zero exit code as failure', async () => {
    const result = await executeShellTool.execute({ command: 'exit 1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/code 1/);
  });

  it('times out long-running commands', async () => {
    // Use a cross-platform busy-wait command
    const cmd = process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 10';
    const result = await executeShellTool.execute({
      command: cmd,
      timeout_ms: 200,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
  }, 10_000);
});
