import { readFile, readdir, stat } from 'fs/promises';
import { resolve, relative, join } from 'path';
import chalk from 'chalk';

export interface AtReference {
  raw: string;       // the original @token in the input
  type: 'file' | 'directory' | 'url';
  target: string;    // resolved path or URL
  content: string;   // expanded content to inject
}

const MAX_FILE_CHARS = 8000;
const MAX_DIR_FILES = 20;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.cache']);

// Match @something — file path, directory, or URL
// Stops at whitespace. Supports quoted paths: @"path with spaces"
const AT_PATTERN = /@(?:"([^"]+)"|(\S+))/g;

export async function resolveAtReferences(
  input: string,
  cwd: string,
): Promise<{ expanded: string; refs: AtReference[] }> {
  const matches = [...input.matchAll(AT_PATTERN)];
  if (matches.length === 0) return { expanded: input, refs: [] };

  const refs: AtReference[] = [];

  for (const match of matches) {
    const raw = match[0];
    const target = match[1] ?? match[2]; // quoted or unquoted

    const ref = await resolveOne(raw, target, cwd);
    if (ref) refs.push(ref);
  }

  // Replace @tokens with a placeholder; append expanded content at the end
  let expanded = input;
  const attachments: string[] = [];

  for (const ref of refs) {
    expanded = expanded.replace(ref.raw, chalk.cyan(ref.raw));
    attachments.push(formatAttachment(ref));
  }

  // Strip chalk codes for the actual message sent to the model
  const plainExpanded = stripAnsi(expanded);
  const fullMessage = attachments.length > 0
    ? plainExpanded + '\n\n' + attachments.join('\n\n')
    : plainExpanded;

  return { expanded: fullMessage, refs };
}

async function resolveOne(
  raw: string,
  target: string,
  cwd: string,
): Promise<AtReference | null> {
  // URL
  if (target.startsWith('http://') || target.startsWith('https://')) {
    const content = await fetchUrlWithSpinner(target);
    return { raw, type: 'url', target, content };
  }

  const absPath = resolve(cwd, target);

  try {
    const info = await stat(absPath);

    if (info.isDirectory()) {
      const content = await readDirContents(absPath, cwd);
      return { raw, type: 'directory', target: absPath, content };
    } else {
      const content = await readFileContents(absPath);
      return { raw, type: 'file', target: absPath, content };
    }
  } catch {
    // path doesn't exist — leave as-is, don't inject
    process.stderr.write(chalk.yellow(`  @ warning: "${target}" not found, skipping\n`));
    return null;
  }
}

async function readFileContents(filePath: string): Promise<string> {
  const raw = await readFile(filePath, 'utf-8');
  if (raw.length > MAX_FILE_CHARS) {
    return raw.slice(0, MAX_FILE_CHARS) + `\n\n[truncated — ${raw.length} total chars]`;
  }
  return raw;
}

async function readDirContents(dirPath: string, cwd: string): Promise<string> {
  const lines: string[] = [];
  await collectFiles(dirPath, dirPath, lines);
  const rel = relative(cwd, dirPath) || '.';
  return `Directory: ${rel}\n` + lines.join('\n');
}

async function collectFiles(root: string, dir: string, lines: string[], depth = 0): Promise<void> {
  if (lines.length >= MAX_DIR_FILES) return;
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    if (lines.length >= MAX_DIR_FILES) break;
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    const indent = '  '.repeat(depth);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      lines.push(`${indent}${entry.name}/`);
      await collectFiles(root, full, lines, depth + 1);
    } else {
      lines.push(`${indent}${entry.name}`);
    }
  }
}

async function fetchUrlWithSpinner(url: string): Promise<string> {
  // Spinner while fetching URL (network call, 10s timeout)
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let idx = 0;
  const shortUrl = url.length > 50 ? url.slice(0, 50) + '…' : url;
  process.stdout.write('\r' + chalk.gray(`${frames[0]} Fetching ${shortUrl}`));
  const interval = setInterval(() => {
    process.stdout.write('\r' + chalk.gray(`${frames[idx]} Fetching ${shortUrl}`));
    idx = (idx + 1) % frames.length;
  }, 80);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      return `[HTTP ${res.status} fetching ${url}]`;
    }
    const text = await res.text();
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    // Strip HTML tags for readability
    const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return stripped.length > MAX_FILE_CHARS
      ? stripped.slice(0, MAX_FILE_CHARS) + '\n[truncated]'
      : stripped;
  } catch (err) {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    return `[Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

function formatAttachment(ref: AtReference): string {
  const label =
    ref.type === 'url' ? `URL: ${ref.target}` :
    ref.type === 'directory' ? `Directory: ${ref.target}` :
    `File: ${ref.target}`;

  const fence = ref.type === 'url' ? '' : detectLanguage(ref.target);
  return `<attachment ${label}>\n\`\`\`${fence}\n${ref.content}\n\`\`\`\n</attachment>`;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml',
    sh: 'bash', css: 'css', html: 'html', sql: 'sql',
  };
  return map[ext] ?? '';
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}
