import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileTool } from '../../src/core/tools/write_file.js';

describe('write_file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `codegrunt-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes a file successfully', async () => {
    const filePath = join(dir, 'out.txt');
    const result = await writeFileTool.execute({ path: filePath, content: 'hello' });
    expect(result.success).toBe(true);
    expect(await readFile(filePath, 'utf-8')).toBe('hello');
  });

  it('creates parent directories', async () => {
    const filePath = join(dir, 'a', 'b', 'c.txt');
    const result = await writeFileTool.execute({ path: filePath, content: 'nested' });
    expect(result.success).toBe(true);
    expect(await readFile(filePath, 'utf-8')).toBe('nested');
  });
});
