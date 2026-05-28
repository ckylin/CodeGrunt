import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, resolve, relative, extname } from 'path';
import chalk from 'chalk';
import type { LLMProvider, CodeGruntConfig } from '../types.js';

const INIT_SKIP = new Set([
  'node_modules', '.git', 'dist', '.next', '__pycache__', '.cache',
  'coverage', '.nyc_output', 'build', 'target', '.turbo',
  '.codegrunt', 'venv', '.venv', '.idea', '.vscode',
]);

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

async function buildFileTree(cwd: string): Promise<string> {
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

async function readKeyFiles(cwd: string): Promise<Record<string, string>> {
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

async function extractPackageScripts(cwd: string): Promise<string | null> {
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

async function extractKeyDependencies(cwd: string): Promise<{ deps: string[]; devDeps: string[] } | null> {
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

interface SourceCandidate {
  path: string;
  score: number; // higher = more important
}

async function collectAndScoreSources(root: string, dir: string, results: SourceCandidate[]): Promise<void> {
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

async function sampleSourceFiles(cwd: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const candidates: SourceCandidate[] = [];
  await collectAndScoreSources(cwd, cwd, candidates);

  // Sort by score descending, take top 10
  candidates.sort((a, b) => b.score - a.score);

  // Ensure diversity: don't take too many from the same directory
  const seen: Set<string> = new Set();
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

async function discoverTestStructure(cwd: string): Promise<string | null> {
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
  } catch {}

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

async function extractReadme(cwd: string): Promise<string | null> {
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

async function extractIgnorePatterns(cwd: string): Promise<string | null> {
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

async function countFileExtensions(root: string, dir: string, counts: Map<string, number>): Promise<void> {
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

async function getLanguageBreakdown(cwd: string): Promise<string | null> {
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

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildInitPrompt(
  cwd: string,
  tree: string,
  keyFiles: Record<string, string>,
  sourceSamples: Record<string, string>,
  outPath: string,
  packageScripts: string | null,
  dependencies: { deps: string[]; devDeps: string[] } | null,
  readme: string | null,
  testStructure: string | null,
  ignorePatterns: string | null,
  languageBreakdown: string | null,
): string {
  // Build a rich context section
  const sections: string[] = [];

  // 1. Project overview from README
  if (readme) {
    sections.push(`## README.md (project overview)
${readme}`);
  }

  // 2. Language breakdown
  if (languageBreakdown) {
    sections.push(`## Language/File Breakdown
${languageBreakdown}`);
  }

  // 3. Package scripts
  if (packageScripts) {
    sections.push(`## package.json Scripts
\`\`\`json
${packageScripts}
\`\`\``);
  }

  // 4. Key dependencies
  if (dependencies) {
    const depsSection = dependencies.deps.length > 0
      ? `\n**Runtime dependencies**: ${dependencies.deps.join(', ')}`
      : '';
    const devDepsSection = dependencies.devDeps.length > 0
      ? `\n**Dev dependencies**: ${dependencies.devDeps.join(', ')}`
      : '';
    if (depsSection || devDepsSection) {
      sections.push(`## Key Dependencies${depsSection}${devDepsSection}`);
    }
  }

  // 5. Test structure
  if (testStructure) {
    sections.push(`## Test Structure
${testStructure}`);
  }

  // 6. Ignore patterns
  if (ignorePatterns) {
    sections.push(`## .gitignore Patterns (build artifacts)
\`\`\`
${ignorePatterns}
\`\`\``);
  }

  // 7. File tree
  sections.push(`## File Tree
\`\`\`
${tree}
\`\`\``);

  // 8. Key config files
  const keyFilesSection = Object.entries(keyFiles)
    .map(([name, content]) => {
      const lang = name.endsWith('.json') ? 'json'
        : name.endsWith('.yml') || name.endsWith('.yaml') ? 'yaml'
        : name.endsWith('.toml') ? 'toml'
        : name.endsWith('.md') ? 'markdown'
        : '';
      return `### ${name}
\`\`\`${lang}
${content}
\`\`\``;
    })
    .join('\n\n');

  sections.push(`## Key Config Files
${keyFilesSection || '(none found)'}`);

  // 9. Source file samples
  const sourceSamplesSection = Object.entries(sourceSamples)
    .map(([name, content]) => {
      const ext = extname(name);
      const lang = ext === '.ts' || ext === '.tsx' ? 'typescript'
        : ext === '.js' || ext === '.jsx' ? 'javascript'
        : ext === '.py' ? 'python'
        : ext === '.go' ? 'go'
        : ext === '.rs' ? 'rust'
        : ext === '.java' ? 'java'
        : '';
      return `### ${name}
\`\`\`${lang}
${content}
\`\`\``;
    })
    .join('\n\n');

  sections.push(`## Source File Samples (architecturally significant)
${sourceSamplesSection || '(none found)'}`);

  return `You are analyzing a codebase to produce a high-quality developer guide. The guide will be saved as \`${outPath}\` and loaded by AI coding assistants (like CodeGrunt and Claude Code) to deeply understand the project.

Below is comprehensive information about the codebase. Study it carefully and produce a detailed, well-structured Markdown document.

${sections.join('\n\n---\n\n')}

---

## Instructions for the CODEGRUNT.md you must produce

Write a detailed Markdown developer guide with the sections below. **Only include sections that are actually relevant** to this project — skip empty sections entirely.

### 1. Build & Dev Commands
- List ALL available development commands: build, dev/watch, test, lint, format, type-check, etc.
- Include the **exact commands** to run a single test file, run a specific test by name, or debug.
- Mention required **engine/toolchain versions** (Node.js version, Python version, Go version, etc.).
- Include any **pre-commit hooks**, CI commands, or deployment scripts visible in the config files.
- If there's a multi-package monorepo, explain how to build/run individual packages.

### 2. Architecture
- Give a **high-level overview** of what the project does (distill from README + code).
- Describe the **entry point(s)** and how the application bootstraps itself.
- For each **major directory/module**, explain:
  - What it's responsible for.
  - How it connects to other modules (data flow, invocation flow).
  - Key files within it and what they do.
- If the project has distinct **layers** (e.g., CLI → Core → Infra), diagram them.
- Mention any **non-obvious architectural decisions** — things that require reading 3+ files to understand.
- If there's a pipeline, state machine, or orchestration pattern, describe the stages/phases.

### 3. Key Patterns & Conventions
- Document **recurring coding patterns**: error handling, dependency injection, discriminated unions, plugin systems, etc.
- Describe **naming conventions** (file naming, function naming, type naming).
- Note any **anti-patterns** to avoid or "gotchas" that could trip up a developer.
- If the project uses **Discriminated/Tagged Unions**, **Result types**, **Builder patterns**, or similar — show a code snippet.
- Document **how new features/modules are typically added** (where to put files, what interfaces to implement).
- Mention **import ordering**, **barrel file conventions**, or module organization rules.

### 4. Configuration
- List every **environment variable** with its effect, defaults, and whether it's required.
- Describe **config files** (where they live, their format, key fields).
- Explain any **configuration loading order** or precedence rules.
- If there's feature flags, runtime toggles, or profile-based config — document them.

### 5. Testing (if applicable)
- Where tests live (directory convention, file naming).
- How to run tests (all, single file, single test, with coverage, in watch mode).
- What test framework(s) and assertion libraries are used.
- Any test utilities, mocks, or fixtures a developer should know about.

### 6. External Dependencies & Services (if applicable)
- Key third-party libraries/APIs the project depends on.
- Any external services (databases, message queues, cloud services) — how to connect/configure them locally.
- API rate limits, authentication mechanisms, or remote config to be aware of.

### Output rules:
- **Be thorough and specific.** Generic advice like "write tests" or "follow conventions" is NOT helpful. Give concrete patterns, real file paths, actual commands.
- **Use the file paths and code samples provided** — reference specific files by name.
- **Show code snippets** for key patterns (from the source samples), not just descriptions.
- **Do NOT list every file** — only mention files that are architecturally significant or represent a pattern.
- **Output raw Markdown only** — do NOT wrap the document in code fences.
- Target 1000-2500 words. A thin 200-word guide is a failure. Be comprehensive.
- Write in English unless the codebase comments/docs are overwhelmingly in another language.`;
}

// ── Main export ─────────────────────────────────────────────────────────────

export async function runInit(
  cwd: string,
  config: CodeGruntConfig,
  provider: LLMProvider,
  outputFile: string,
): Promise<void> {
  const outPath = resolve(cwd, outputFile || 'CODEGRUNT.md');
  console.log(chalk.gray(`Analyzing codebase at ${cwd}…`));

  // Phase 1: Gather data (parallel where possible)
  // Show dot-progress while scanning (large projects can take seconds)
  const scanDots = setInterval(() => process.stdout.write(chalk.gray('.')), 200);

  const [
    tree,
    keyContents,
    sourceSamples,
    packageScripts,
    dependencies,
    readme,
    testStructure,
    ignorePatterns,
    languageBreakdown,
  ] = await Promise.all([
    buildFileTree(cwd),
    readKeyFiles(cwd),
    sampleSourceFiles(cwd),
    extractPackageScripts(cwd),
    extractKeyDependencies(cwd),
    extractReadme(cwd),
    discoverTestStructure(cwd),
    extractIgnorePatterns(cwd),
    getLanguageBreakdown(cwd),
  ]);

  clearInterval(scanDots);

  // Print summary of what we found
  const foundItems: string[] = [];
  if (packageScripts) foundItems.push('scripts');
  if (dependencies?.deps.length) foundItems.push('deps');
  if (readme) foundItems.push('README');
  if (testStructure) foundItems.push('tests');
  if (languageBreakdown) foundItems.push('lang-stats');
  if (Object.keys(keyContents).length > 0) foundItems.push(`${Object.keys(keyContents).length} config files`);
  if (Object.keys(sourceSamples).length > 0) foundItems.push(`${Object.keys(sourceSamples).length} source samples`);
  console.log(chalk.gray(`  Found: ${foundItems.join(', ')}`));

  // Phase 2: Build prompt and generate
  const prompt = buildInitPrompt(
    cwd, tree, keyContents, sourceSamples, outPath,
    packageScripts, dependencies, readme,
    testStructure, ignorePatterns, languageBreakdown,
  );

  process.stdout.write(chalk.gray('\nGenerating CODEGRUNT.md'));

  let output = '';
  try {
    const stream = provider.stream(
      [{ role: 'user', content: prompt }],
      { model: config.model, maxTokens: 8192, temperature: 0.2 },
    );
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') {
        output += chunk.text;
        process.stdout.write('.');
      }
    }
  } catch (err) {
    console.log(chalk.red('\nFailed: ' + (err instanceof Error ? err.message : String(err))));
    return;
  }

  // Clean up potential wrapping code fences
  const cleaned = output
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  if (!cleaned) {
    console.log(chalk.yellow('\nModel returned empty output. The guide was not saved.'));
    return;
  }

  await writeFile(outPath, cleaned + '\n', 'utf-8');

  process.stdout.write('\n');
  console.log(chalk.green(`✓ Written to ${relative(cwd, outPath)}`) +
    chalk.gray(` (${cleaned.length.toLocaleString()} chars)`));
  console.log(chalk.gray(`  This file will be automatically loaded as project context on the next run.\n`));
}
