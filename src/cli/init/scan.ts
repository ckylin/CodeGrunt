// ── Project scanning for /init ──────────────────────────────────────────────
// Reads the working tree and gathers the facts the init prompt is built from.

import { readdir, readFile } from 'fs/promises';
import { join, relative, extname } from 'path';
import { SKIP_DIRS_INIT as INIT_SKIP } from '../../utils/fs-ignore.js';

// Files that provide critical project context — read in full or with a generous limit
const INIT_KEY_FILES = [
  // JS/TS ecosystem
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'tsconfig.json', 'tsconfig.base.json', 'tsconfig.build.json',
  'vite.config.ts', 'vite.config.js',
  'vitest.config.ts', 'vitest.workspace.ts', 'jest.config.ts', 'jest.config.js',
  '.eslintrc', '.eslintrc.js', '.eslintrc.json', 'eslint.config.js', 'eslint.config.mjs',
  '.prettierrc', '.prettierrc.js', '.prettierrc.json', 'prettier.config.js',
  'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile',
  // Python
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'requirements-dev.txt',
  'Pipfile', 'tox.ini',
  // Rust/Go/Java
  'Cargo.toml', 'go.mod', 'go.sum', 'build.gradle', 'build.gradle.kts', 'pom.xml',
  // Docs
  'README.md', 'README', 'CHANGELOG.md', 'CONTRIBUTING.md', 'CODEGRUNT.md', 'CLAUDE.md',
  // Config
  '.env.example', '.env.template', '.editorconfig',
  '.gitignore', '.dockerignore',
];

// Source file extensions we care about for architecture sampling
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.hpp', '.rb', '.php', '.cs', '.scala']);

// Files likely to be architecturally significant (barrels, main entry, types)
const ARCHITECTURAL_FILES = new Set([
  'index.ts', 'index.tsx', 'index.js', 'index.jsx',
  'main.ts', 'main.tsx', 'main.js', 'main.jsx',
  'app.ts', 'app.tsx', 'app.js', 'app.jsx',
  'server.ts', 'server.js',
  'types.ts', 'types.d.ts', 'interfaces.ts',
  'config.ts', 'config.js', 'constants.ts', 'constants.js',
]);

// ── File tree builder (depth 4, smarter filtering) ──────────────────────────

export async function buildFileTree(cwd: string): Promise<string> {
  const lines: string[] = [];
  await walkTree(cwd, cwd, 0, 4, lines, new Set());
  return lines.join('\n');
}

async function walkTree(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  lines: string[],
  seenDirs: Set<string>,
): Promise<void> {
  if (depth > maxDepth || lines.length > 200) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Permission errors, etc.
  }

  // Sort: directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (lines.length > 200) break;

    // Skip hidden files/dirs at depth > 0 (but show hidden dirs at root for config discovery)
    if (entry.name.startsWith('.') && depth > 0 && entry.name !== '.env.example' && entry.name !== '.env.template') {
      continue;
    }
    if (INIT_SKIP.has(entry.name)) continue;

    const indent = '  '.repeat(depth);
    if (entry.isDirectory()) {
      const dirKey = join(dir, entry.name);
      if (seenDirs.has(dirKey)) continue;
      seenDirs.add(dirKey);

      lines.push(`${indent}${entry.name}/`);
      await walkTree(root, dirKey, depth + 1, maxDepth, lines, seenDirs);
    } else {
      lines.push(`${indent}${entry.name}`);
    }
  }
}

// ── Key files reader ────────────────────────────────────────────────────────

export async function readKeyFiles(cwd: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of INIT_KEY_FILES) {
    const p = join(cwd, name);
    try {
      // package.json gets more budget since it's high-value
      const isPkgJson = name === 'package.json';
      const limit = isPkgJson ? 8000 : 5000;
      const content = await readFile(p, 'utf-8');
      result[name] = content.length > limit
        ? content.slice(0, limit) + '\n[truncated]'
        : content;
    } catch {
      // file doesn't exist — skip
    }
  }
  return result;
}

// ── package.json scripts extraction ─────────────────────────────────────────

export async function extractPackageScripts(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    if (!pkg.scripts || Object.keys(pkg.scripts).length === 0) return null;

    const lines: string[] = [];
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      lines.push(`  "${name}": "${cmd}"`);
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}

// ── Dependency summary ──────────────────────────────────────────────────────

export async function extractKeyDependencies(cwd: string): Promise<{ deps: string[]; devDeps: string[] } | null> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);

    const deps = pkg.dependencies ? Object.keys(pkg.dependencies) : [];
    const devDeps = pkg.devDependencies ? Object.keys(pkg.devDependencies) : [];

    // Filter to notable / non-obvious dependencies (skip the routine ones)
    const notable = (name: string) =>
      !['typescript', '@types/node', 'prettier', 'eslint', 'jest', 'vitest',
        'tsx', 'ts-node', 'rimraf', 'cross-env', 'dotenv'].includes(name);

    return {
      deps: deps.filter(notable).slice(0, 30),
      devDeps: devDeps.filter(notable).slice(0, 30),
    };
  } catch {
    return null;
  }
}

// ── Source file sampling (smarter selection) ─────────────────────────────────

export interface SourceCandidate {
  path: string;
  score: number; // higher = more important
}

export async function collectAndScoreSources(root: string, dir: string, results: SourceCandidate[]): Promise<void> {
  if (results.length >= 60) return; // collect enough to rank, then pick top N

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= 60) return;
    if (entry.name.startsWith('.') || INIT_SKIP.has(entry.name)) continue;

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectAndScoreSources(root, full, results);
    } else if (SOURCE_EXTS.has(extname(entry.name))) {
      const rel = relative(root, full);
      let score = 0;

      // Architectural files get high priority
      if (ARCHITECTURAL_FILES.has(entry.name)) score += 10;
      // Barrel files / index files
      if (entry.name.startsWith('index.')) score += 5;
      // Type definition files
      if (entry.name.endsWith('.d.ts')) score += 4;
      if (entry.name === 'types.ts' || entry.name === 'types.js') score += 8;
      // Config files
      if (entry.name.includes('config') || entry.name.includes('constants')) score += 3;
      // Files in src/ or lib/ get higher priority
      if (rel.startsWith('src') || rel.startsWith('lib')) score += 2;
      // Files at root level
      if (!rel.includes('/') && !rel.includes('\\')) score += 1;
      // Shorter depth is generally more important
      const depth = rel.split(/[/\\]/).length;
      score += Math.max(0, 5 - depth);

      results.push({ path: rel, score });
    }
  }
}

export async function sampleSourceFiles(cwd: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const candidates: SourceCandidate[] = [];
  await collectAndScoreSources(cwd, cwd, candidates);

  // Sort by score descending, take top 10
  candidates.sort((a, b) => b.score - a.score);

  // Ensure diversity: don't take too many from the same directory
  const selected: string[] = [];
  for (const c of candidates) {
    if (selected.length >= 10) break;
    const dir = c.path.substring(0, c.path.lastIndexOf('/'));
    const dirKey = dir || '(root)';
    // Max 2 files per directory to ensure breadth
    const countInDir = selected.filter(s => {
      const sd = s.substring(0, s.lastIndexOf('/'));
      return (sd || '(root)') === dirKey;
    }).length;
    if (countInDir >= 2) continue;
    selected.push(c.path);
  }

  for (const rel of selected) {
    try {
      const content = await readFile(join(cwd, rel), 'utf-8');
      result[rel] = content.length > 3000
        ? content.slice(0, 3000) + '\n[truncated]'
        : content;
    } catch {
      // skip unreadable files
    }
  }
  return result;
}

// ── Test file discovery ─────────────────────────────────────────────────────

export async function discoverTestStructure(cwd: string): Promise<string | null> {
  const patterns: string[] = [];

  // Check for common test directories
  for (const testDir of ['tests', 'test', '__tests__', 'spec', '__spec__']) {
    try {
      const full = join(cwd, testDir);
      const stat = await readdir(full);
      if (stat.length > 0) {
        // Show a few example test files
        const testFiles = stat.filter(f => f.includes('.test.') || f.includes('.spec.') || f.includes('_test.'));
        const examples = testFiles.slice(0, 5);
        if (examples.length > 0) {
          patterns.push(`${testDir}/ (${examples.join(', ')}, ...)`);
        } else {
          patterns.push(`${testDir}/ (${stat.slice(0, 5).join(', ')}${stat.length > 5 ? ', ...' : ''})`);
        }
      }
    } catch {
      // doesn't exist
    }
  }

  // Also check for test runner config — read cwd once
  const testConfigSignatures = new Set([
    'vitest', 'jest', 'mocha', 'ava', 'tap', 'playwright', 'cypress',
  ]);
  const foundConfigs: string[] = [];
  try {
    const entries = await readdir(cwd);
    for (const e of entries) {
      const lowerE = e.toLowerCase();
      for (const sig of testConfigSignatures) {
        if (lowerE.includes(sig) && (e.endsWith('.config.ts') || e.endsWith('.config.js') || e.endsWith('.config.mjs') || e.endsWith('.json'))) {
          foundConfigs.push(e);
          break;
        }
      }
    }
  } catch { /* unreadable directory: report whatever was collected so far */ }

  if (patterns.length === 0 && foundConfigs.length === 0) return null;

  let out = '';
  if (foundConfigs.length > 0) {
    out += `Test config files: ${foundConfigs.join(', ')}\n`;
  }
  if (patterns.length > 0) {
    out += `Test directories: ${patterns.join('; ')}`;
  }
  return out || null;
}

// ── README.md extraction ────────────────────────────────────────────────────

export async function extractReadme(cwd: string): Promise<string | null> {
  try {
    const content = await readFile(join(cwd, 'README.md'), 'utf-8');
    // Take first 4000 chars — the README intro usually has the best overview
    return content.length > 4000
      ? content.slice(0, 4000) + '\n[truncated]'
      : content;
  } catch {
    return null;
  }
}

// ── .gitignore extraction ───────────────────────────────────────────────────

export async function extractIgnorePatterns(cwd: string): Promise<string | null> {
  try {
    const content = await readFile(join(cwd, '.gitignore'), 'utf-8');
    // Filter out comments and empty lines, take meaningful patterns
    const patterns = content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    if (patterns.length === 0) return null;
    return patterns.slice(0, 30).join('\n');
  } catch {
    return null;
  }
}

// ── Language breakdown ──────────────────────────────────────────────────────

export async function countFileExtensions(root: string, dir: string, counts: Map<string, number>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || INIT_SKIP.has(entry.name)) continue;

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await countFileExtensions(root, full, counts);
    } else {
      const ext = extname(entry.name);
      if (ext) {
        counts.set(ext, (counts.get(ext) || 0) + 1);
      }
    }
  }
}

export async function getLanguageBreakdown(cwd: string): Promise<string | null> {
  const counts = new Map<string, number>();
  await countFileExtensions(cwd, cwd, counts);

  if (counts.size === 0) return null;

  const sorted = [...counts.entries()]
    .filter(([, count]) => count >= 3) // only show extensions with 3+ files
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sorted.length === 0) return null;

  return sorted.map(([ext, count]) => `${ext} (${count} files)`).join(', ');
}
