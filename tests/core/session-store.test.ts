import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createFakeHome, type FakeHome } from '../helpers/fake-home.js';
import type { Message } from '../../src/types.js';

type Store = typeof import('../../src/core/session/store.js');

let fake: FakeHome;
let store: Store;

beforeEach(async () => {
  fake = await createFakeHome();
  store = await import('../../src/core/session/store.js');
});

afterEach(async () => {
  await fake.cleanup();
});

const user = (content: string): Message => ({ role: 'user', content }) as Message;
const system = (content: string): Message => ({ role: 'system', content }) as Message;
const assistant = (content: string): Message => ({ role: 'assistant', content }) as Message;

describe('session store', () => {
  it('keeps sessions under the (fake) home directory, never the real one', () => {
    expect(store.SESSIONS_DIR.startsWith(fake.home)).toBe(true);
  });

  it('saveSession returns a uuid and loadSession round-trips the full record', async () => {
    const messages = [system('sys'), user('hello world'), assistant('hi')];
    const id = await store.saveSession(messages, { cwd: '/proj', model: 'm1' });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const rec = await store.loadSession(id);
    expect(rec).toMatchObject({ id, cwd: '/proj', model: 'm1', title: 'hello world' });
    expect(rec?.messages).toEqual(messages);
  });

  it('messageCount excludes system messages, but they are still stored', async () => {
    const id = await store.saveSession([system('sys'), user('a'), assistant('b')], { cwd: '/p', model: 'm' });
    const rec = await store.loadSession(id);
    expect(rec?.messageCount).toBe(2);
    expect(rec?.messages).toHaveLength(3);
  });

  it('title is the first user message, cut at 80 chars with an ellipsis', async () => {
    const id = await store.saveSession([user('x'.repeat(100))], { cwd: '/p', model: 'm' });
    const rec = await store.loadSession(id);
    expect(rec?.title).toBe('x'.repeat(80) + '…');
  });

  it('title falls back to "(no messages)" when there is no user message', async () => {
    const id = await store.saveSession([system('sys'), assistant('hi')], { cwd: '/p', model: 'm' });
    expect((await store.loadSession(id))?.title).toBe('(no messages)');
  });

  it('title drops everything from a "[Previous conversation summary]" marker onward', async () => {
    const id = await store.saveSession([user('real question [Previous conversation summary] old stuff')], { cwd: '/p', model: 'm' });
    expect((await store.loadSession(id))?.title).toBe('real question');
  });

  it('a message that starts with the summary marker yields an empty title (not the fallback)', async () => {
    const id = await store.saveSession([user('[Previous conversation summary] only this')], { cwd: '/p', model: 'm' });
    expect((await store.loadSession(id))?.title).toBe('');
  });

  it('saving with an existing id updates in place and keeps one index entry', async () => {
    const id = await store.saveSession([user('first')], { cwd: '/p', model: 'm' });
    await store.saveSession([user('first'), assistant('reply')], { id, cwd: '/p', model: 'm' });
    const list = await store.listSessions('/p');
    expect(list).toHaveLength(1);
    expect(list[0].messageCount).toBe(2);
  });

  it('rejects ids that are not uuids (path traversal guard)', async () => {
    expect(await store.loadSession('../../etc/passwd')).toBeNull();
    expect(await store.deleteSession('../../etc/passwd')).toBe(false);
    await expect(store.saveSession([user('x')], { id: '../evil', cwd: '/p', model: 'm' })).rejects.toThrow(/Invalid session id/);
  });

  it('loadSession returns null for a valid but unknown id', async () => {
    expect(await store.loadSession('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('listSessions filters by cwd, newest first; listAllSessions spans cwds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const a = await store.saveSession([user('a')], { cwd: '/one', model: 'm' });
    vi.setSystemTime(new Date('2025-01-02T00:00:00Z'));
    const b = await store.saveSession([user('b')], { cwd: '/one', model: 'm' });
    vi.setSystemTime(new Date('2025-01-03T00:00:00Z'));
    const c = await store.saveSession([user('c')], { cwd: '/two', model: 'm' });

    expect((await store.listSessions('/one')).map(e => e.id)).toEqual([b, a]);
    expect((await store.listSessions('/two')).map(e => e.id)).toEqual([c]);
    expect((await store.listAllSessions()).map(e => e.id)).toEqual([c, b, a]);
  });

  it('keeps at most 20 sessions per cwd, deleting the oldest files from disk', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      vi.setSystemTime(new Date(Date.UTC(2025, 0, 1, 0, i)));
      ids.push(await store.saveSession([user(`m${i}`)], { cwd: '/p', model: 'm' }));
    }
    const list = await store.listSessions('/p');
    expect(list).toHaveLength(20);
    expect(list.map(e => e.id)).not.toContain(ids[0]);
    expect(list.map(e => e.id)).toContain(ids[21]);
    expect(existsSync(join(store.SESSIONS_DIR, `${ids[0]}.json`))).toBe(false);
    expect(existsSync(join(store.SESSIONS_DIR, `${ids[21]}.json`))).toBe(true);
  });

  it('deleteSession removes the file and the index entry; unknown ids return false', async () => {
    const id = await store.saveSession([user('x')], { cwd: '/p', model: 'm' });
    expect(await store.deleteSession(id)).toBe(true);
    expect(existsSync(join(store.SESSIONS_DIR, `${id}.json`))).toBe(false);
    expect(await store.listSessions('/p')).toEqual([]);
    expect(await store.deleteSession(id)).toBe(false);
  });

  it('a corrupt index file reads as an empty list', async () => {
    await store.saveSession([user('x')], { cwd: '/p', model: 'm' });
    await writeFile(join(store.SESSIONS_DIR, 'index.jsonl'), '{not json\n', 'utf-8');
    expect(await store.listAllSessions()).toEqual([]);
  });

  it('writes the index as JSONL, one entry per line', async () => {
    await store.saveSession([user('a')], { cwd: '/p', model: 'm' });
    await store.saveSession([user('b')], { cwd: '/p', model: 'm' });
    const raw = await readFile(join(store.SESSIONS_DIR, 'index.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(JSON.parse(l)).toHaveProperty('id');
  });

  it('formatSessionEntry shows message count and title', () => {
    const s = store.formatSessionEntry({
      id: 'x', cwd: '/p', model: 'm', savedAt: '2025-01-01T12:00:00Z', title: 'my title', messageCount: 7,
    });
    expect(s).toMatch(/^\[.+\] \(7 msgs\) my title$/);
  });
});
