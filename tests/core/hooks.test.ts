import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createFakeHome, type FakeHome } from '../helpers/fake-home.js';

type Hooks = typeof import('../../src/core/hooks/registry.js');

let fake: FakeHome;
let hooks: Hooks;
let hooksDir: string;

beforeEach(async () => {
  fake = await createFakeHome();
  hooksDir = join(fake.home, '.codegrunt', 'hooks');
  await mkdir(hooksDir, { recursive: true });
  hooks = await import('../../src/core/hooks/registry.js');
});

afterEach(async () => {
  await fake.cleanup();
});

/** Writes a CommonJS hook that ignores stdin and prints `stdout`, optionally exiting non-zero. */
async function jsHook(file: string, stdout: string, exitCode = 0): Promise<void> {
  const body = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(stdout)});process.exit(${exitCode});});`;
  await writeFile(join(hooksDir, file), body, 'utf-8');
}

const preTool = { event: 'pre-tool-use' as const, tool_name: 'read_file', tool_input: {}, cwd: '/p' };

describe('HookRegistry.load', () => {
  it('finds nothing when the hooks dir is missing', async () => {
    const { rm } = await import('fs/promises');
    await rm(hooksDir, { recursive: true, force: true });
    const reg = new hooks.HookRegistry();
    reg.load();
    expect(reg.list()).toEqual([]);
  });

  it('matches exact event names and "-" / "_" suffixed names, in lexicographic order', async () => {
    for (const f of ['pre-tool-use.js', 'pre-tool-use-b.js', 'pre-tool-use_a.js', 'stop.cjs', 'post-tool-use.mjs', 'user-prompt-submit.sh']) {
      await writeFile(join(hooksDir, f), '', 'utf-8');
    }
    const reg = new hooks.HookRegistry();
    reg.load();
    expect(reg.hooksFor('pre-tool-use').map(h => h.name)).toEqual(['pre-tool-use-b.js', 'pre-tool-use.js', 'pre-tool-use_a.js']);
    expect(reg.hooksFor('stop').map(h => h.name)).toEqual(['stop.cjs']);
    expect(reg.hooksFor('post-tool-use')).toHaveLength(1);
    expect(reg.hooksFor('user-prompt-submit')).toHaveLength(1);
  });

  it('ignores unsupported extensions and names that merely start with an event name', async () => {
    for (const f of ['pre-tool-use.py', 'pre-tool-use.txt', 'pre-tool-usefoo.js', 'random.js', 'README.md']) {
      await writeFile(join(hooksDir, f), '', 'utf-8');
    }
    const reg = new hooks.HookRegistry();
    reg.load();
    expect(reg.list()).toEqual([]);
  });

  it('load() is idempotent: it rebuilds the list instead of appending', async () => {
    await writeFile(join(hooksDir, 'stop.js'), '', 'utf-8');
    const reg = new hooks.HookRegistry();
    reg.load();
    reg.load();
    expect(reg.list()).toHaveLength(1);
  });

  it('list() returns a copy', async () => {
    await writeFile(join(hooksDir, 'stop.js'), '', 'utf-8');
    const reg = new hooks.HookRegistry();
    reg.load();
    reg.list().pop();
    expect(reg.list()).toHaveLength(1);
  });
});

describe('HookRegistry.run', () => {
  it('returns continue when no hook is registered for the event', async () => {
    const reg = new hooks.HookRegistry();
    reg.load();
    expect(await reg.run(preTool)).toEqual({ action: 'continue' });
  });

  it('passes the event as JSON on stdin', async () => {
    const out = join(fake.home, 'stdin.json');
    await writeFile(
      join(hooksDir, 'pre-tool-use.js'),
      `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(out)},s);process.stdout.write('{"action":"continue"}');});`,
      'utf-8',
    );
    const reg = new hooks.HookRegistry();
    reg.load();
    await reg.run(preTool);
    expect(JSON.parse(await readFile(out, 'utf-8'))).toEqual(preTool);
  });

  it('returns a block response', async () => {
    await jsHook('pre-tool-use.js', '{"action":"block","reason":"nope"}');
    const reg = new hooks.HookRegistry();
    reg.load();
    expect(await reg.run(preTool)).toEqual({ action: 'block', reason: 'nope' });
  });

  it('the first block wins and later hooks are not run', async () => {
    const marker = join(fake.home, 'ran-after-block');
    await jsHook('pre-tool-use-a.js', '{"action":"block","reason":"first"}');
    await writeFile(join(hooksDir, 'pre-tool-use-b.js'), `require('fs').writeFileSync(${JSON.stringify(marker)},'x');process.stdout.write('{"action":"continue"}');`, 'utf-8');
    const reg = new hooks.HookRegistry();
    reg.load();
    expect(await reg.run(preTool)).toEqual({ action: 'block', reason: 'first' });
    expect(existsSync(marker)).toBe(false);
  });

  it('the last modify wins; modify data is NOT merged across hooks (the doc comment says "merged")', async () => {
    await jsHook('pre-tool-use-a.js', '{"action":"modify","data":{"a":1}}');
    await jsHook('pre-tool-use-b.js', '{"action":"modify","data":{"b":2}}');
    const reg = new hooks.HookRegistry();
    reg.load();
    expect(await reg.run(preTool)).toEqual({ action: 'modify', data: { b: 2 } });
  });

  it('a modify followed by continue still returns the modify', async () => {
    await jsHook('pre-tool-use-a.js', '{"action":"modify","data":{"a":1}}');
    await jsHook('pre-tool-use-b.js', '{"action":"continue"}');
    const reg = new hooks.HookRegistry();
    reg.load();
    expect(await reg.run(preTool)).toEqual({ action: 'modify', data: { a: 1 } });
  });

  it('a block after a modify still blocks', async () => {
    await jsHook('pre-tool-use-a.js', '{"action":"modify","data":{"a":1}}');
    await jsHook('pre-tool-use-b.js', '{"action":"block","reason":"late"}');
    const reg = new hooks.HookRegistry();
    reg.load();
    expect(await reg.run(preTool)).toEqual({ action: 'block', reason: 'late' });
  });

  it('a non-zero exit is treated as continue, even if it printed a block', async () => {
    await jsHook('pre-tool-use.js', '{"action":"block","reason":"ignored"}', 1);
    const reg = new hooks.HookRegistry();
    reg.load();
    expect(await reg.run(preTool)).toEqual({ action: 'continue' });
  });

  it('invalid JSON, unknown actions and empty output all fall back to continue', async () => {
    for (const out of ['not json', '{"action":"explode"}', '']) {
      await jsHook('pre-tool-use.js', out);
      const reg = new hooks.HookRegistry();
      reg.load();
      expect(await reg.run(preTool)).toEqual({ action: 'continue' });
    }
  });

  it('only hooks for the emitted event type run', async () => {
    await jsHook('stop.js', '{"action":"block","reason":"stop hook"}');
    const reg = new hooks.HookRegistry();
    reg.load();
    expect(await reg.run(preTool)).toEqual({ action: 'continue' });
    expect(await reg.run({ event: 'stop', cwd: '/p', response_length: 3 })).toEqual({ action: 'block', reason: 'stop hook' });
  });
});

describe('getHookRegistry', () => {
  it('loads once and returns the same instance', async () => {
    await writeFile(join(hooksDir, 'stop.js'), '', 'utf-8');
    const a = hooks.getHookRegistry();
    expect(a.list()).toHaveLength(1);
    expect(hooks.getHookRegistry()).toBe(a);
  });
});
