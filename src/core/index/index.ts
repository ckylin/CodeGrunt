// ── Code Symbol Index ─────────────────────────────────────────────────────
// Builds a lightweight index of code symbols (functions, classes, exports)
// using ripgrep / grep patterns. No external dependencies, no embedding model.
//
// Index format: JSON file per project at ~/.codegrunt/index/<cwd-hash>/index.json
//   {
//     "builtAt": "<iso>",
//     "cwd": "/path/to/project",
//     "symbols": [
//       { "name": "myFunction", "kind": "function", "file": "src/foo.ts", "line": 12 }
//     ],
//     "files": ["src/foo.ts", ...]
//   }
//
// code_search tool uses this index for fast symbol lookup, falling back to
// grep if no index exists.

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getLogger } from '../observability/logger.js';

const execFileAsync = promisify(execFile);
const log = getLogger('index');

const INDEX_DIR = join(homedir(), '.codegrunt', 'index');
const BUILD_TIMEOUT_MS = 60_000;

// ── Types ─────────────────────────────────────────────────────────────────

export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'export' | 'const' | 'variable';
  file: string;
  line: number;
}

export interface CodeIndex {
  builtAt: string;
  cwd: string;
  symbols: CodeSymbol[];
  files: string[];
}

// ── Paths ─────────────────────────────────────────────────────────────────

function indexPath(cwd: string): string {
  const hash = createHash('md5').update(cwd).digest('hex').slice(0, 8);
  return join(INDEX_DIR, hash, 'index.json');
}

// ── Loader / saver ────────────────────────────────────────────────────────

export async function loadIndex(cwd: string): Promise<CodeIndex | null> {
  const p = indexPath(cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf-8');
    return JSON.parse(raw) as CodeIndex;
  } catch {
    return null;
  }
}

async function saveIndex(cwd: string, index: CodeIndex): Promise<void> {
  const p = indexPath(cwd);
  await mkdir(join(INDEX_DIR, createHash('md5').update(cwd).digest('hex').slice(0, 8)), { recursive: true });
  await writeFile(p, JSON.stringify(index, null, 2), 'utf-8');
}

// ── Pattern extraction ────────────────────────────────────────────────────

interface RawSymbol {
  name: string;
  kind: CodeSymbol['kind'];
  file: string;
  line: number;
}

const PATTERNS: Array<{ lang: string[]; exts: string[]; pattern: string; kind: CodeSymbol['kind'] }> = [
  {
    lang: ['TypeScript', 'JavaScript'],
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    pattern: '(export\\s+)?(async\\s+)?function\\s+(\\w+)',
    kind: 'function',
  },
  {
    lang: ['TypeScript', 'JavaScript'],
    exts: ['.ts', '.tsx', '.js', '.jsx'],
    pattern: 'export\\s+(default\\s+)?class\\s+(\\w+)',
    kind: 'class',
  },
  {
    lang: ['TypeScript'],
    exts: ['.ts', '.tsx'],
    pattern: 'export\\s+interface\\s+(\\w+)',
    kind: 'interface',
  },
  {
    lang: ['TypeScript'],
    exts: ['.ts', '.tsx'],
    pattern: 'export\\s+type\\s+(\\w+)',
    kind: 'type',
  },
  {
    lang: ['TypeScript', 'JavaScript'],
    exts: ['.ts', '.tsx', '.js', '.jsx'],
    pattern: 'export\\s+(const|let|var)\\s+(\\w+)',
    kind: 'export',
  },
  {
    lang: ['Python'],
    exts: ['.py'],
    pattern: 'def\\s+(\\w+)\\s*\\(',
    kind: 'function',
  },
  {
    lang: ['Python'],
    exts: ['.py'],
    pattern: 'class\\s+(\\w+)[\\s:(]',
    kind: 'class',
  },
  {
    lang: ['Go'],
    exts: ['.go'],
    pattern: 'func\\s+(\\([^)]*\\)\\s+)?(\\w+)\\s*\\(',
    kind: 'function',
  },
  {
    lang: ['Rust'],
    exts: ['.rs'],
    pattern: '(pub\\s+)?(async\\s+)?fn\\s+(\\w+)',
    kind: 'function',
  },
  {
    lang: ['Rust'],
    exts: ['.rs'],
    pattern: '(pub\\s+)?struct\\s+(\\w+)',
    kind: 'class',
  },
];

const INDEXABLE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.codegrunt']);

/** Recursively walk cwd collecting indexable source files, skipping common noise dirs. */
async function walkFiles(cwd: string, dir = '.', out: string[] = []): Promise<string[]> {
  const absDir = join(cwd, dir);
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkFiles(cwd, join(dir, entry.name), out);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'));
      if (INDEXABLE_EXTS.has(ext)) out.push(join(dir, entry.name).replace(/\\/g, '/'));
    }
  }
  return out;
}

/**
 * List indexable files, preferring `git ls-files` (respects .gitignore) with
 * a plain directory walk as fallback when the cwd isn't a git repo.
 *
 * Uses execFile with an argument array (not a shell string) so filenames
 * containing quotes/backticks/`$()` can never be interpreted as shell syntax.
 */
async function listFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd, timeout: 15000 },
    );
    const files = stdout.trim().split('\n').filter(Boolean);
    if (files.length > 0) {
      return files.filter(f => INDEXABLE_EXTS.has(f.slice(f.lastIndexOf('.'))));
    }
  } catch {
    // not a git repo or git unavailable — fall through to manual walk
  }
  return walkFiles(cwd);
}

async function extractSymbols(cwd: string): Promise<RawSymbol[]> {
  const symbols: RawSymbol[] = [];

  const fileList = await listFiles(cwd);
  if (fileList.length === 0) return [];

  // For each pattern, run grep directly against the matching files — passed
  // as separate argv entries (execFile, no shell) so a filename can never
  // break out of quoting and inject shell syntax.
  for (const { exts, pattern, kind } of PATTERNS) {
    const matchingFiles = fileList.filter(f => exts.some(ext => f.endsWith(ext))).slice(0, 500);
    if (matchingFiles.length === 0) continue;

    try {
      const { stdout } = await execFileAsync(
        'grep', ['-En', pattern, ...matchingFiles],
        { cwd, timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
      );

      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        // Format: file:linenum:content
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (!match) continue;
        const [, file, lineStr, content] = match;

        // Extract symbol name from content
        const nameMatch = content.match(/(?:function|class|interface|type|const|let|var|def|func|fn|struct)\s+(?:\([^)]*\)\s+)?(\w+)/);
        if (!nameMatch) continue;

        symbols.push({
          name: nameMatch[1],
          kind,
          file,
          line: parseInt(lineStr, 10),
        });
      }
    } catch {
      // grep exits non-zero when there are no matches — that's expected, not an error
    }
  }

  // Deduplicate by file+line
  const seen = new Set<string>();
  return symbols.filter(s => {
    const key = `${s.file}:${s.line}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Build index ───────────────────────────────────────────────────────────

export async function buildIndex(
  cwd: string,
  onProgress?: (msg: string) => void,
): Promise<CodeIndex> {
  onProgress?.('Scanning files…');
  log.info('Building code index', { cwd });

  const start = Date.now();

  const symbols = await Promise.race([
    extractSymbols(cwd),
    new Promise<RawSymbol[]>((_, reject) =>
      setTimeout(() => reject(new Error('Index build timed out')), BUILD_TIMEOUT_MS)
    ),
  ]);

  // Unique files
  const files = [...new Set(symbols.map(s => s.file))];

  const index: CodeIndex = {
    builtAt: new Date().toISOString(),
    cwd,
    symbols: symbols as CodeSymbol[],
    files,
  };

  await saveIndex(cwd, index);

  const elapsed = Date.now() - start;
  log.info('Code index built', { symbols: symbols.length, files: files.length, elapsed });
  onProgress?.(`Indexed ${symbols.length} symbols across ${files.length} files (${elapsed}ms)`);

  return index;
}

// ── Search ────────────────────────────────────────────────────────────────

export interface SearchHit {
  symbol: CodeSymbol;
  score: number;
}

export function searchIndex(index: CodeIndex, query: string, maxResults = 10, kind?: CodeSymbol['kind']): SearchHit[] {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);

  const candidates = kind ? index.symbols.filter(s => s.kind === kind) : index.symbols;

  const scored = candidates.map(symbol => {
    const nameLower = symbol.name.toLowerCase();
    const fileLower = symbol.file.toLowerCase();

    let score = 0;

    // Exact name match
    if (nameLower === q) score += 100;
    // Name starts with query
    else if (nameLower.startsWith(q)) score += 60;
    // Name contains query
    else if (nameLower.includes(q)) score += 30;
    // Individual words in name
    else {
      for (const word of words) {
        if (nameLower.includes(word)) score += 10;
      }
    }

    // File path bonus
    if (fileLower.includes(q)) score += 5;

    return { symbol, score };
  });

  return scored
    .filter(h => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
