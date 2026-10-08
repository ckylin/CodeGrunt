import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createFakeHome, type FakeHome } from '../helpers/fake-home.js';

type LoggerMod = typeof import('../../src/core/observability/logger.js');
type BusMod = typeof import('../../src/core/events/bus.js');

let fake: FakeHome;
let mod: LoggerMod;
let bus: BusMod;
let stderr: ReturnType<typeof vi.spyOn>;

const written = (): string => stderr.mock.calls.map(c => String(c[0])).join('');

async function waitFor(cond: () => Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
}

beforeEach(async () => {
  fake = await createFakeHome();
  vi.stubEnv('CODEGRUNT_LOG_LEVEL', '');
  vi.stubEnv('CODEGRUNT_VERBOSE', '');
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  bus = await import('../../src/core/events/bus.js');
  mod = await import('../../src/core/observability/logger.js');
});

afterEach(async () => {
  await fake.cleanup();
});

describe('Logger stderr output', () => {
  it('warn and error always print, with a [namespace] LEVEL: prefix', () => {
    const log = new mod.Logger('ns', { fileLogging: false });
    log.warn('careful');
    log.error('broken');
    expect(written()).toContain('\n[ns] WARN: careful\n');
    expect(written()).toContain('\n[ns] ERROR: broken\n');
  });

  it('info and debug are silent unless CODEGRUNT_VERBOSE is set', () => {
    const quiet = new mod.Logger('ns', { fileLogging: false, minLevel: 'debug' });
    quiet.info('hello');
    quiet.debug('dbg');
    expect(written()).toBe('');

    vi.stubEnv('CODEGRUNT_VERBOSE', '1');
    quiet.info('hello');
    expect(written()).toBe('[ns] INFO: hello\n');
  });

  it('minLevel filters out lower levels', () => {
    const log = new mod.Logger('ns', { fileLogging: false, minLevel: 'error' });
    log.warn('dropped');
    log.error('kept');
    expect(written()).not.toContain('dropped');
    expect(written()).toContain('kept');
  });

  it('an unrecognised CODEGRUNT_LOG_LEVEL disables filtering entirely (comparison against undefined is never true)', () => {
    vi.stubEnv('CODEGRUNT_LOG_LEVEL', 'bogus');
    const log = new mod.Logger('ns', { fileLogging: false });
    vi.stubEnv('CODEGRUNT_VERBOSE', '1');
    log.debug('still shown');
    expect(written()).toContain('[ns] DEBUG: still shown');
  });

  it('an empty CODEGRUNT_LOG_LEVEL behaves the same way (empty string is not nullish, so it is not defaulted to info)', () => {
    const log = new mod.Logger('ns', { fileLogging: false });
    vi.stubEnv('CODEGRUNT_VERBOSE', '1');
    log.debug('shown too');
    expect(written()).toContain('DEBUG: shown too');
  });
});

describe('Logger EventBus integration', () => {
  it('error logs emit an ErrorEvent on the default bus, carrying data.stack', () => {
    const seen: unknown[] = [];
    bus.getDefaultEventBus().on('error', e => { seen.push(e); });
    new mod.Logger('src', { fileLogging: false }).error('kaput', { stack: 'STACK' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'error', source: 'src', message: 'kaput', stack: 'STACK' });
  });

  it('warn does not emit, and emitErrors:false suppresses error events', () => {
    const h = vi.fn();
    bus.getDefaultEventBus().on('error', h);
    const log = new mod.Logger('src', { fileLogging: false, emitErrors: false });
    log.warn('w');
    log.error('e');
    expect(h).not.toHaveBeenCalled();
  });
});

describe('Logger identity', () => {
  it('uses a given runId, otherwise generates a uuid', () => {
    expect(new mod.Logger('a', { fileLogging: false, runId: 'fixed' }).getRunId()).toBe('fixed');
    expect(new mod.Logger('a', { fileLogging: false }).getRunId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('child() joins namespaces with ":" and shares the parent runId', () => {
    const parent = new mod.Logger('parent', { fileLogging: false, runId: 'rid' });
    const child = parent.child('kid');
    child.warn('x');
    expect(written()).toContain('[parent:kid] WARN: x');
    expect(child.getRunId()).toBe('rid');
  });

  it('getLogger caches by namespace; createLogger caches by namespace + runId', () => {
    expect(mod.getLogger('same')).toBe(mod.getLogger('same'));
    expect(mod.getLogger('same')).not.toBe(mod.getLogger('other'));
    const a = mod.createLogger('ns', 'r1');
    expect(mod.createLogger('ns', 'r1')).toBe(a);
    expect(mod.createLogger('ns', 'r2')).not.toBe(a);
    expect(a.getRunId()).toBe('r1');
  });

  it('getLogDir points under the (fake) home', () => {
    expect(mod.getLogDir()).toBe(join(fake.home, '.codegrunt', 'logs'));
  });
});

describe('Logger file transport', () => {
  it('CODEGRUNT_LOG_FILE=0 and =false disable file logging by default', async () => {
    new mod.Logger('a');
    vi.stubEnv('CODEGRUNT_LOG_FILE', 'false');
    new mod.Logger('b');
    await new Promise(r => setTimeout(r, 100));
    await expect(readdir(mod.getLogDir())).rejects.toThrow();
  });

  it('writes a "Log session started" entry then one JSON line per log call', async () => {
    const dir = join(fake.home, 'logs-out');
    const log = new mod.Logger('file-ns', { fileLogging: true, logDir: dir, runId: 'abcdef12-0000' });
    // Entries logged before the async init finishes are dropped, so wait for the boot line.
    await waitFor(async () => (await readdir(dir).catch(() => [])).length > 0);
    const [file] = await readdir(dir);
    expect(file).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-abcdef12\.jsonl$/);

    log.warn('to file', { k: 1 });
    await waitFor(async () => (await readFile(join(dir, file), 'utf-8')).includes('to file'));
    const lines = (await readFile(join(dir, file), 'utf-8')).trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0]).toMatchObject({ level: 'info', namespace: 'logger', message: 'Log session started', runId: 'abcdef12-0000' });
    expect(lines[1]).toMatchObject({ level: 'warn', namespace: 'file-ns', message: 'to file', data: { k: 1 } });
  });

  it('prunes the oldest .jsonl files so at most 5 exist after the new one is created', async () => {
    const dir = join(fake.home, 'logs-rotate');
    await mkdir(dir, { recursive: true });
    for (let i = 1; i <= 6; i++) await writeFile(join(dir, `2000-01-0${i}T00-00-00-old${i}.jsonl`), '', 'utf-8');
    await writeFile(join(dir, 'notes.txt'), '', 'utf-8');

    new mod.Logger('rot', { fileLogging: true, logDir: dir, runId: 'newrun01' });
    await waitFor(async () => (await readdir(dir)).some(f => f.endsWith('-newrun01.jsonl')));

    const files = (await readdir(dir)).sort();
    // 6 old files were pruned down to 4, plus the new one = 5; non-jsonl files are left alone.
    expect(files.filter(f => f.endsWith('.jsonl'))).toHaveLength(5);
    expect(files).toContain('notes.txt');
    expect(files).not.toContain('2000-01-01T00-00-00-old1.jsonl');
    expect(files).not.toContain('2000-01-02T00-00-00-old2.jsonl');
    expect(files).toContain('2000-01-06T00-00-00-old6.jsonl');
  });

  it('only the first logger with file logging initialises the transport (module-level flag)', async () => {
    const dirA = join(fake.home, 'first');
    const dirB = join(fake.home, 'second');
    new mod.Logger('a', { fileLogging: true, logDir: dirA });
    await waitFor(async () => (await readdir(dirA).catch(() => [])).length > 0);
    new mod.Logger('b', { fileLogging: true, logDir: dirB });
    await new Promise(r => setTimeout(r, 100));
    await expect(readdir(dirB)).rejects.toThrow();
  });
});
