import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildFileTree, readKeyFiles, extractPackageScripts, extractKeyDependencies,
  sampleSourceFiles, discoverTestStructure, extractIgnorePatterns, getLanguageBreakdown,
} from '../../src/cli/init/scan.js';
import { buildInitPrompt } from '../../src/cli/init/prompt.js';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `codegrunt-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(dir, 'src', 'core'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    scripts: { build: 'tsc', test: 'vitest' },
    dependencies: { chalk: '1', dotenv: '1' },
    devDependencies: { vitest: '1', tsx: '1', zod: '1' },
  }));
  await writeFile(join(dir, 'README.md'), '# Demo\nhello');
  await writeFile(join(dir, '.gitignore'), '# build\ndist\n\nnode_modules\n');
  await writeFile(join(dir, 'src', 'index.ts'), 'export {}');
  await writeFile(join(dir, 'src', 'types.ts'), 'export type A = 1');
  await writeFile(join(dir, 'src', 'core', 'a.ts'), 'a');
  await writeFile(join(dir, 'src', 'core', 'b.ts'), 'b');
  await writeFile(join(dir, 'src', 'core', 'c.ts'), 'c');
  await writeFile(join(dir, 'tests', 'a.test.ts'), 't');
  await writeFile(join(dir, 'vitest.config.ts'), 'export default {}');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('init scan', () => {
  it('builds a tree with directories first and skips node_modules', async () => {
    const tree = await buildFileTree(dir);
    const lines = tree.split('\n');
    expect(lines.some((l) => l.includes('node_modules'))).toBe(false);
    expect(lines.indexOf('src/')).toBeLessThan(lines.indexOf('README.md'));
    expect(lines).toContain('  index.ts');
  });

  it('reads key files that exist and ignores the rest', async () => {
    const files = await readKeyFiles(dir);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['package.json', 'README.md', '.gitignore']));
    expect(files['Cargo.toml']).toBeUndefined();
  });

  it('truncates oversized key files with a marker', async () => {
    await writeFile(join(dir, 'Makefile'), 'x'.repeat(6000));
    const files = await readKeyFiles(dir);
    expect(files['Makefile'].endsWith('[truncated]')).toBe(true);
  });

  it('extracts scripts and notable dependencies', async () => {
    expect(await extractPackageScripts(dir)).toContain('"build": "tsc"');
    const deps = await extractKeyDependencies(dir);
    expect(deps?.deps).toEqual(['chalk']);
    expect(deps?.devDeps).toEqual(['zod']);
  });

  it('returns null for scripts/deps when there is no package.json', async () => {
    const empty = join(dir, 'tests');
    expect(await extractPackageScripts(empty)).toBeNull();
    expect(await extractKeyDependencies(empty)).toBeNull();
  });

  it('samples architectural sources, at most two per directory', async () => {
    const samples = await sampleSourceFiles(dir);
    const names = Object.keys(samples).map((n) => n.replace(/\\/g, '/'));
    expect(names).toEqual(expect.arrayContaining(['src/index.ts', 'src/types.ts']));
    expect(names.filter((n) => n.startsWith('src/core/')).length).toBeLessThanOrEqual(2);
  });

  it('finds test directories and runner configs', async () => {
    const out = await discoverTestStructure(dir);
    expect(out).toContain('vitest.config.ts');
    expect(out).toContain('tests/');
  });

  it('keeps only real gitignore patterns', async () => {
    expect(await extractIgnorePatterns(dir)).toBe('dist\nnode_modules');
  });

  it('reports extensions with at least three files', async () => {
    // index, types, a, b, c, a.test and vitest.config: seven .ts files; .json/.md are below the threshold
    expect(await getLanguageBreakdown(dir)).toBe('.ts (7 files)');
  });
});

describe('buildInitPrompt', () => {
  it('includes the sections that have data and skips the ones that do not', () => {
    const prompt = buildInitPrompt('/p', 'src/', { 'package.json': '{}' }, {}, '/p/CODEGRUNT.md', null, null, '# Hi', null, null, null);
    expect(prompt).toContain('## README.md (project overview)');
    expect(prompt).toContain('### package.json');
    expect(prompt).toContain('/p/CODEGRUNT.md');
    expect(prompt).not.toContain('## package.json Scripts');
    expect(prompt).toContain('(none found)');
  });
});
