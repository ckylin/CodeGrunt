import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileTool } from '../../src/core/tools/read_file.js';

describe('read_file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `codegrunt-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('reads a file successfully', async () => {
    const filePath = join(dir, 'hello.txt');
    await writeFile(filePath, 'hello world');
    const result = await readFileTool.execute({ path: filePath });
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello world');
  });

  it('returns error for missing file', async () => {
    const result = await readFileTool.execute({ path: join(dir, 'nonexistent.txt') });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to read/);
  });

  it('truncates large files', async () => {
    const filePath = join(dir, 'large.txt');
    await writeFile(filePath, 'x'.repeat(110_000));
    const result = await readFileTool.execute({ path: filePath });
    expect(result.success).toBe(true);
    expect(result.output).toContain('truncated');
  });
});
