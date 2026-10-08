import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileTool } from '../../src/core/tools/read-file.js';
import { executeShellTool } from '../../src/core/tools/execute-shell.js';
import { listDirectoryTool } from '../../src/core/tools/list-directory.js';
import { searchFilesTool } from '../../src/core/tools/search-files.js';
import { editFileTool } from '../../src/core/tools/edit-file.js';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `codegrunt-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('read_file continuation', () => {
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n');

  it('cuts at the line limit and names the next start_line', async () => {
    const p = join(dir, 'big.txt');
    await writeFile(p, numbered(2500));
    const r = await readFileTool.execute({ path: p });
    expect(r.success).toBe(true);
    expect(r.output).toContain('line2000');
    expect(r.output).not.toContain('line2001\n');
    expect(r.output).toContain('start_line=2001');
  });

  it('reads a range and labels it', async () => {
    const p = join(dir, 'r.txt');
    await writeFile(p, numbered(10));
    const r = await readFileTool.execute({ path: p, start_line: 3, end_line: 5 });
    expect(r.output).toBe('[Lines 3-5 of 10 total]\nline3\nline4\nline5');
  });

  it('accepts start_line alone', async () => {
    const p = join(dir, 's.txt');
    await writeFile(p, numbered(5));
    const r = await readFileTool.execute({ path: p, start_line: 4 });
    expect(r.output).toBe('[Lines 4-5 of 5 total]\nline4\nline5');
  });

  it('errors when start_line is past the end', async () => {
    const p = join(dir, 'e.txt');
    await writeFile(p, numbered(3));
    const r = await readFileTool.execute({ path: p, start_line: 50 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/beyond the end/);
  });

  it('resolves relative paths against ctx.cwd', async () => {
    await writeFile(join(dir, 'rel.txt'), 'rel');
    const r = await readFileTool.execute({ path: 'rel.txt' }, { cwd: dir });
    expect(r.output).toBe('rel');
  });
});

describe('execute_shell', () => {
  it('keeps only the tail of huge output and reports the full-output file', async () => {
    const cmd = `node -e "for(let i=1;i<=3000;i++)console.log('row'+i)"`;
    const r = await executeShellTool.execute({ command: cmd, cwd: dir });
    expect(r.success).toBe(true);
    expect(r.output).toContain('row3000');
    expect(r.output).not.toContain('row1\n');
    expect(r.output).toMatch(/Output truncated/);
    const path = /Full output: (\S+?)\.log/.exec(r.output);
    expect(path).not.toBeNull();
  }, 20_000);

  it('aborts a running command when the signal fires', async () => {
    const ac = new AbortController();
    const cmd = `node -e "setTimeout(()=>{},20000)"`;
    const started = Date.now();
    const p = executeShellTool.execute({ command: cmd, cwd: dir, timeout_ms: 60_000 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/aborted/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('does not start when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await executeShellTool.execute({ command: 'echo hi', cwd: dir }, { signal: ac.signal });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/aborted/);
  });
});

describe('list_directory', () => {
  it('nests children under their parent, directories first, case-insensitive', async () => {
    await mkdir(join(dir, 'zeta', 'inner'), { recursive: true });
    await mkdir(join(dir, 'alpha'), { recursive: true });
    await writeFile(join(dir, 'Banana.txt'), '');
    await writeFile(join(dir, 'apple.txt'), '');
    await writeFile(join(dir, 'alpha', 'a1.txt'), '');
    await writeFile(join(dir, 'zeta', 'inner', 'deep.txt'), '');
    const r = await listDirectoryTool.execute({ path: dir });
    expect(r.output.split('\n')).toEqual([
      'alpha/',
      '  a1.txt',
      'zeta/',
      '  inner/',
      '    deep.txt',
      'apple.txt',
      'Banana.txt',
    ]);
  });

  it('marks skipped directories without expanding them', async () => {
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    const r = await listDirectoryTool.execute({ path: dir });
    expect(r.output).toBe('node_modules/ (skipped)');
  });

  it('errors on a missing path instead of reporting an empty directory', async () => {
    const r = await listDirectoryTool.execute({ path: join(dir, 'nope') });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it('reports how many entries were cut off by max_entries', async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(dir, `f${i}.txt`), '');
    const r = await listDirectoryTool.execute({ path: dir, max_entries: 2 });
    expect(r.output).toMatch(/3 more entries not shown/);
  });
});

describe('search_files', () => {
  it('supports ignore_case and limit', async () => {
    await writeFile(join(dir, 'a.ts'), 'Hello\nhello\nHELLO\n');
    const sensitive = await searchFilesTool.execute({ pattern: 'hello', path: dir });
    expect(sensitive.output.split('\n')).toHaveLength(1);
    const insensitive = await searchFilesTool.execute({ pattern: 'hello', path: dir, ignore_case: true });
    expect(insensitive.output.split('\n')).toHaveLength(3);
  });

  it('truncates very long matching lines', async () => {
    await writeFile(join(dir, 'long.ts'), 'needle ' + 'x'.repeat(2000) + '\n');
    const r = await searchFilesTool.execute({ pattern: 'needle', path: dir });
    expect(r.output).toContain('[truncated]');
    expect(r.output.length).toBeLessThan(700);
  });
});

describe('edit_file', () => {
  it('tolerates smart quotes in old_string and reports it', async () => {
    const p = join(dir, 'q.ts');
    await writeFile(p, 'const s = “abc”;\n');
    const r = await editFileTool.execute({ path: p, old_string: 'const s = "abc";', new_string: 'const s = "xyz";' });
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/ignoring whitespace\/quote/);
    expect(await readFile(p, 'utf-8')).toBe('const s = "xyz";\n');
  });

  it('rejects an empty old_string', async () => {
    const p = join(dir, 'e.ts');
    await writeFile(p, 'abc');
    const r = await editFileTool.execute({ path: p, old_string: '', new_string: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/must not be empty/);
  });

  it('serializes concurrent edits to the same file so none are lost', async () => {
    const p = join(dir, 'c.ts');
    await writeFile(p, 'A\nB\nC\n');
    const results = await Promise.all([
      editFileTool.execute({ path: p, old_string: 'A', new_string: 'a' }),
      editFileTool.execute({ path: p, old_string: 'B', new_string: 'b' }),
      editFileTool.execute({ path: p, old_string: 'C', new_string: 'c' }),
    ]);
    expect(results.every((r) => r.success)).toBe(true);
    expect(await readFile(p, 'utf-8')).toBe('a\nb\nc\n');
  });
});
