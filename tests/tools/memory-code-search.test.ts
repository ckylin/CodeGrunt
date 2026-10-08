import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { createFakeHome, type FakeHome } from '../helpers/fake-home.js';

let fake: FakeHome;

beforeEach(async () => {
  fake = await createFakeHome();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await fake.cleanup();
});

describe('memory tools', () => {
  const load = () => import('../../src/core/tools/memory.js');
  const write = async (args: Record<string, unknown>) => (await load()).memoryWriteTool.execute(args);
  const read = async (args: Record<string, unknown> = {}) => (await load()).memoryReadTool.execute(args);
  const base = { name: 'prefers_tabs', type: 'user', description: 'uses tabs', body: 'always tabs' };

  it('read on an empty store says so', async () => {
    expect(await read()).toEqual({ success: true, output: 'No memory entries found.' });
  });

  it('write returns the name and an 8-char id, and read formats the entry', async () => {
    const w = await write(base);
    const id = /\(id: ([0-9a-f]{8})\)/.exec(w.output)?.[1];
    expect(w.output).toBe(`Memory saved: prefers_tabs (id: ${id})`);
    expect((await read()).output).toBe(`[${id}] (user) prefers_tabs: uses tabs\nalways tabs`);
  });

  it('joins several entries with a --- separator, in write order', async () => {
    await write({ ...base, id: 'aaaaaaaa', name: 'first' });
    await write({ ...base, id: 'bbbbbbbb', name: 'second' });
    const out = (await read()).output;
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
    expect(out).toContain('\n\n---\n\n');
  });

  it('read filters by type', async () => {
    await write({ ...base, id: 'aaaaaaaa', type: 'user', name: 'u' });
    await write({ ...base, id: 'bbbbbbbb', type: 'project', name: 'p' });
    const out = (await read({ type: 'project' })).output;
    expect(out).toContain('(project) p');
    expect(out).not.toContain('(user)');
    expect((await read({ type: 'reference' })).output).toBe('No memory entries found.');
  });

  it('writing with an existing id updates in place and keeps the original createdAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    await write({ ...base, id: 'cccccccc' });
    vi.setSystemTime(new Date('2025-06-01T00:00:00Z'));
    await write({ ...base, id: 'cccccccc', body: 'changed' });

    const { readEntries } = await import('../../src/core/memory/store.js');
    const entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'cccccccc', body: 'changed', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-06-01T00:00:00.000Z' });
  });

  it('an unknown id is created as a new entry with that id', async () => {
    const w = await write({ ...base, id: 'dddddddd' });
    expect(w.output).toContain('(id: dddddddd)');
  });
});

describe('code_search tool', () => {
  const cwd = '/some/project';
  const hash = createHash('md5').update(cwd).digest('hex').slice(0, 8);

  async function seedIndex(extra: Record<string, unknown> = {}): Promise<void> {
    const dir = join(fake.home, '.codegrunt', 'index', hash);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.json'), JSON.stringify({
      builtAt: '2025-01-01T00:00:00.000Z',
      cwd,
      files: ['a.ts', 'b.ts'],
      symbols: [
        { name: 'getUser', kind: 'function', file: 'a.ts', line: 10 },
        { name: 'getUserById', kind: 'function', file: 'a.ts', line: 20 },
        { name: 'UserType', kind: 'type', file: 'b.ts', line: 3 },
      ],
      ...extra,
    }), 'utf-8');
  }

  async function run(args: Record<string, unknown>) {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const { codeSearchTool } = await import('../../src/core/tools/code-search.js');
    return codeSearchTool.execute(args);
  }

  it('tells the user to run /index when no index exists', async () => {
    const r = await run({ query: 'foo' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('No code index found for this project. Run /index to build one first.');
    expect(r.output).toContain('search_files with pattern "foo"');
  });

  it('lists keyword hits best first, as file:line [kind] name', async () => {
    await seedIndex();
    const r = await run({ query: 'getUser' });
    const lines = r.output.split('\n');
    expect(lines[0]).toBe('Found 2 results for "getUser":');
    // exact match (100) outranks the prefix match (60)
    expect(lines[2]).toBe('a.ts:10  [function]  getUser');
    expect(lines[3]).toBe('a.ts:20  [function]  getUserById');
    expect(r.output).toContain('Index: 3 symbols, built ');
  });

  it('uses the singular "result" for one hit', async () => {
    await seedIndex();
    expect((await run({ query: 'UserType' })).output).toMatch(/^Found 1 result for "UserType":/);
  });

  it('filters by a valid kind and ignores an invalid one', async () => {
    await seedIndex();
    const typed = await run({ query: 'user', kind: 'type' });
    expect(typed.output).toContain('UserType');
    expect(typed.output).not.toContain('getUser');
    const bogus = await run({ query: 'user', kind: 'nonsense' });
    expect(bogus.output).toContain('getUser');
    expect(bogus.output).toContain('UserType');
  });

  it('honours max_results, capped at 20', async () => {
    const symbols = Array.from({ length: 30 }, (_, i) => ({ name: `item${i}`, kind: 'const', file: 'f.ts', line: i + 1 }));
    await seedIndex({ symbols });
    expect((await run({ query: 'item', max_results: 3 })).output).toMatch(/^Found 3 results/);
    expect((await run({ query: 'item', max_results: 99 })).output).toMatch(/^Found 20 results/);
    expect((await run({ query: 'item' })).output).toMatch(/^Found 10 results/);
  });

  it('explains an empty result, including index size and the search mode', async () => {
    await seedIndex();
    const r = await run({ query: 'zzz', kind: 'function' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('No symbols matching "zzz" (kind: function) found in index.');
    expect(r.output).toContain('Index contains 3 symbols across 2 files.');
    expect(r.output).toContain('Search mode: keyword (run /index --semantic for fuzzy matching)');
  });
});
