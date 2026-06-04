import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { editFileTool } from '../../src/core/tools/edit_file.js';

describe('edit_file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `codegrunt-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces a unique string successfully', async () => {
    const filePath = join(dir, 'hello.ts');
    await writeFile(filePath, 'const x = 1;\nconst y = 2;\n');
    const result = await editFileTool.execute({
      path: filePath,
      old_string: 'const x = 1;',
      new_string: 'const x = 42;',
    });
    expect(result.success).toBe(true);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('const x = 42;\nconst y = 2;\n');
  });

  it('returns error when old_string is not found', async () => {
    const filePath = join(dir, 'hello.ts');
    await writeFile(filePath, 'const x = 1;\n');
    const result = await editFileTool.execute({
      path: filePath,
      old_string: 'const z = 99;',
      new_string: 'const z = 0;',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('returns error when old_string is ambiguous (appears more than once)', async () => {
    const filePath = join(dir, 'hello.ts');
    await writeFile(filePath, 'foo()\nfoo()\n');
    const result = await editFileTool.execute({
      path: filePath,
      old_string: 'foo()',
      new_string: 'bar()',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/more than once/);
    // File should be unchanged
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('foo()\nfoo()\n');
  });

  it('uses pre-read content from _originalContent if provided', async () => {
    const filePath = join(dir, 'hello.ts');
    await writeFile(filePath, 'const a = 1;\n');
    const original = 'const a = 1;\n';
    const result = await editFileTool.execute({
      path: filePath,
      old_string: 'const a = 1;',
      new_string: 'const a = 99;',
      _originalContent: original,
    });
    expect(result.success).toBe(true);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('const a = 99;\n');
  });
});
