import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../src/utils/confirm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/confirm.js')>();
  return { ...actual, confirmEdit: vi.fn(), confirmShellCommand: vi.fn() };
});

import { confirmEdit, confirmShellCommand } from '../../src/utils/confirm.js';
import { executeToolCall } from '../../src/core/tools/tool-executor.js';
import { repairToolArgs } from '../../src/core/tools/args-repair.js';
import {
  setTrustMode, resetYesAll, isYesAllActive, setWorkspacePermissions, getTrustMode,
} from '../../src/core/policy/state.js';

const confirmEditMock = vi.mocked(confirmEdit);
const confirmShellMock = vi.mocked(confirmShellCommand);

describe('repairToolArgs', () => {
  it('parses plain JSON', () => {
    expect(repairToolArgs('{"path":"a.ts"}')).toEqual({ path: 'a.ts' });
  });

  it('strips markdown fences', () => {
    expect(repairToolArgs('```json\n{"path":"a.ts"}\n```')).toEqual({ path: 'a.ts' });
  });

  it('extracts the first object from surrounding prose', () => {
    expect(repairToolArgs('here you go: {"path":"a.ts"} thanks')).toEqual({ path: 'a.ts' });
  });

  it('fixes trailing commas and unquoted keys', () => {
    expect(repairToolArgs('{path: "a.ts",}')).toEqual({ path: 'a.ts' });
  });

  it('returns null when nothing parses', () => {
    expect(repairToolArgs('not json at all')).toBeNull();
  });

  it('with a tool name: renames close typos, drops unknown keys, coerces types', () => {
    const r = repairToolArgs('{"Path":"a.ts","startline":"5","bogus":1}', 'read_file');
    expect(r).toEqual({ path: 'a.ts', start_line: 5 });
  });

  it('with a tool name: coerces boolean strings and stringifies numbers', () => {
    expect(repairToolArgs('{"pattern":12,"is_regex":"yes"}', 'search_files')).toEqual({ pattern: '12', is_regex: true });
  });

  it('with an unknown tool name: returns the parsed object untouched', () => {
    expect(repairToolArgs('{"x":1}', 'no_such_tool')).toEqual({ x: 1 });
  });
});

describe('executeToolCall gates', () => {
  let dir: string;
  const args = (o: Record<string, unknown>) => JSON.stringify(o);

  beforeEach(async () => {
    dir = join(tmpdir(), `codegrunt-gates-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    confirmEditMock.mockReset();
    confirmShellMock.mockReset();
    setTrustMode('code');
    resetYesAll();
    setWorkspacePermissions(null);
  });

  afterEach(async () => {
    setTrustMode('code');
    resetYesAll();
    setWorkspacePermissions(null);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('reports a missing required parameter', async () => {
    const r = await executeToolCall('write_file', args({ path: 'a.txt' }), dir);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Missing required parameter "content"');
  });

  it('read-only tools never prompt', async () => {
    await writeFile(join(dir, 'r.txt'), 'hi');
    const r = await executeToolCall('read_file', args({ path: 'r.txt' }), dir);
    expect(r.success).toBe(true);
    expect(confirmEditMock).not.toHaveBeenCalled();
  });

  it('permission deny blocks everything, even in auto mode', async () => {
    setTrustMode('auto');
    setWorkspacePermissions({ tools: { write_file: 'deny' } });
    const r = await executeToolCall('write_file', args({ path: 'a.txt', content: 'x' }), dir);
    expect(r.success).toBe(false);
    expect(r.userRejected).toBe(true);
    expect(r.error).toContain('denied');
  });

  it('plan mode blocks destructive tools', async () => {
    setTrustMode('plan');
    for (const [name, a] of [
      ['write_file', { path: 'a.txt', content: 'x' }],
      ['edit_file', { path: 'a.txt', old_string: 'a', new_string: 'b' }],
      ['execute_shell', { command: 'echo hi' }],
    ] as const) {
      const r = await executeToolCall(name, args(a), dir);
      expect(r.success).toBe(false);
      expect(r.userRejected).toBe(true);
      expect(r.error).toContain('plan mode');
    }
    expect(getTrustMode()).toBe('plan');
  });

  it("plan mode lets an explicit 'allow' permission through", async () => {
    setTrustMode('plan');
    setWorkspacePermissions({ tools: { write_file: 'allow' } });
    const r = await executeToolCall('write_file', args({ path: 'a.txt', content: 'x' }), dir);
    expect(r.success).toBe(true);
    expect(confirmEditMock).not.toHaveBeenCalled();
  });

  it('code mode asks before writing; rejection leaves the file untouched', async () => {
    confirmEditMock.mockResolvedValue({ choice: 'no', originalContent: '' });
    const r = await executeToolCall('write_file', args({ path: 'a.txt', content: 'x' }), dir);
    expect(r.success).toBe(false);
    expect(r.userRejected).toBe(true);
    expect(r.error).toBe('Write rejected by user.');
    await expect(readFile(join(dir, 'a.txt'), 'utf-8')).rejects.toThrow();
  });

  it('accepting writes the file', async () => {
    confirmEditMock.mockResolvedValue({ choice: 'yes', originalContent: '' });
    const r = await executeToolCall('write_file', args({ path: 'a.txt', content: 'x' }), dir);
    expect(r.success).toBe(true);
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('x');
  });

  it('edit_file fails before prompting when old_string is missing or ambiguous', async () => {
    await writeFile(join(dir, 'e.txt'), 'foo\nfoo\n');
    const ambiguous = await executeToolCall('edit_file', args({ path: 'e.txt', old_string: 'foo', new_string: 'bar' }), dir);
    expect(ambiguous.error).toContain('more than once');
    const missing = await executeToolCall('edit_file', args({ path: 'e.txt', old_string: 'zzz', new_string: 'bar' }), dir);
    expect(missing.error).toContain('not found');
    expect(confirmEditMock).not.toHaveBeenCalled();
  });

  it('"yes for all" sticks until resetYesAll()', async () => {
    confirmEditMock.mockResolvedValue({ choice: 'yes_all_session', originalContent: '' });
    await executeToolCall('write_file', args({ path: 'a.txt', content: '1' }), dir);
    expect(isYesAllActive()).toBe(true);
    await executeToolCall('write_file', args({ path: 'b.txt', content: '2' }), dir);
    expect(confirmEditMock).toHaveBeenCalledTimes(1);

    resetYesAll();
    confirmEditMock.mockResolvedValue({ choice: 'yes', originalContent: '' });
    await executeToolCall('write_file', args({ path: 'c.txt', content: '3' }), dir);
    expect(confirmEditMock).toHaveBeenCalledTimes(2);
  });

  it("auto mode skips prompts, but permission 'ask' forces one", async () => {
    setTrustMode('auto');
    const skipped = await executeToolCall('write_file', args({ path: 'a.txt', content: '1' }), dir);
    expect(skipped.success).toBe(true);
    expect(confirmEditMock).not.toHaveBeenCalled();

    setWorkspacePermissions({ tools: { write_file: 'ask' } });
    confirmEditMock.mockResolvedValue({ choice: 'no', originalContent: '' });
    const asked = await executeToolCall('write_file', args({ path: 'b.txt', content: '2' }), dir);
    expect(confirmEditMock).toHaveBeenCalledTimes(1);
    expect(asked.userRejected).toBe(true);
  });

  it('execute_shell goes through the shell confirm gate', async () => {
    confirmShellMock.mockResolvedValue('no');
    const rejected = await executeToolCall('execute_shell', args({ command: 'echo hi' }), dir);
    expect(rejected.error).toBe('Command rejected by user.');
    expect(rejected.userRejected).toBe(true);

    confirmShellMock.mockResolvedValue('yes');
    const ok = await executeToolCall('execute_shell', args({ command: 'echo hi' }), dir);
    expect(ok.success).toBe(true);
    expect(ok.output.trim()).toBe('hi');
  });

  it('execute_shell inherits the turn cwd', async () => {
    setTrustMode('auto');
    await writeFile(join(dir, 'marker.txt'), '');
    const cmd = process.platform === 'win32' ? 'dir /b' : 'ls';
    const r = await executeToolCall('execute_shell', args({ command: cmd }), dir);
    expect(r.output).toContain('marker.txt');
  });

  it('a pre-aborted signal stops shell commands', async () => {
    setTrustMode('auto');
    const ac = new AbortController();
    ac.abort();
    const r = await executeToolCall('execute_shell', args({ command: 'echo hi' }), dir, ac.signal);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/aborted/);
  });
});
