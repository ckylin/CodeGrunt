import { createReadStream, statSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, resolve, extname } from 'path';
import { createInterface } from 'readline';
import type { Tool, ToolResult } from '../../types.js';

const MAX_RESULTS = 50;
const MAX_FILE_BYTES = 512 * 1024; // 512 KB — skip binary/large files
const CONCURRENCY = 32; // parallel file reads — higher since we stream
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.cache']);
// File extensions likely to be text — everything else is skipped for safety/speed
const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.pyi', '.pyx',
  '.rs', '.go', '.java', '.kt', '.kts', '.scala',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
  '.cs', '.vb',
  '.rb', '.php', '.pl', '.pm', '.swift',
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.sass',
  '.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql',
  '.vue', '.svelte', '.astro', '.sol',
  '.prisma', '.proto', '.thrift',
  '.env', '.gitignore', '.dockerignore', '.editorconfig',
  '.Dockerfile', 'Dockerfile',
  'Makefile', 'CMakeLists.txt',
]);

/** Stream-search a single file; returns up to maxMatches line snippets. Stops reading as soon as limit is hit. */
function searchFileStream(absPath: string, pattern: string, relPath: string, maxMatches: number, regex?: RegExp): Promise<string[]> {
  return new Promise((res) => {
    let size = 0;
    try { size = statSync(absPath).size; } catch { res([]); return; }
    if (size > MAX_FILE_BYTES) { res([]); return; }

    const matches: string[] = [];
    let lineNo = 0;

    const stream = createReadStream(absPath, { highWaterMark: 65536 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      lineNo++;
      const hit = regex ? regex.test(line) : line.includes(pattern);
      if (hit) {
        matches.push(`${relPath}:${lineNo}: ${line.trim()}`);
        if (matches.length >= maxMatches) {
          rl.close();
          stream.destroy();
        }
      }
    });

    rl.on('close', () => res(matches));
    stream.on('error', () => res(matches));
  });
}

export const searchFilesTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a pattern in files. Returns matching file paths and line snippets. Supports regex search via is_regex:true. Set include_hidden:true to also search files and directories starting with ".".',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The text pattern to search for',
          },
          path: {
            type: 'string',
            description: 'Directory to search in (defaults to current directory)',
          },
          file_pattern: {
            type: 'string',
            description: 'Glob-like file extension filter, e.g. ".ts" or ".py" (optional)',
          },
          is_regex: {
            type: 'boolean',
            description: 'If true, treat pattern as a regular expression (default false)',
          },
          include_hidden: {
            type: 'boolean',
            description: 'If true, include files and directories whose names start with "." (default false)',
          },
        },
        required: ['pattern'],
      },
    },
  },

  async execute(args): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const searchPath = resolve((args.path as string | undefined) ?? '.');
    const filePattern = args.file_pattern as string | undefined;
    const isRegex = !!(args.is_regex as boolean | undefined);
    const includeHidden = !!(args.include_hidden as boolean | undefined);

    if (!pattern) {
      return { success: false, output: '', error: 'Missing required parameter "pattern"' };
    }

    let regex: RegExp | undefined;
    if (isRegex) {
      try {
        regex = new RegExp(pattern);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { success: false, output: '', error: `Invalid regex pattern: ${message}` };
      }
    }

    const results: string[] = [];
    let pending: Array<{ root: string; relDir: string }> = [{ root: searchPath, relDir: '' }];
    let fileQueue: Array<{ root: string; relPath: string }> = [];

    // ── Phase 1: collect all candidate files (parallel BFS) ──
    try {
      while (pending.length > 0) {
        const batch = pending.splice(0, CONCURRENCY);
        const dirResults = await Promise.all(
          batch.map(async ({ root, relDir }) => {
            const absDir = join(root, relDir);
            let entries;
            try {
              entries = await readdir(absDir, { withFileTypes: true });
            } catch {
              return { subdirs: [] as Array<{ root: string; relDir: string }>, files: [] as Array<{ root: string; relPath: string }> };
            }
            const subdirs: Array<{ root: string; relDir: string }> = [];
            const files: Array<{ root: string; relPath: string }> = [];
            for (const e of entries) {
              if (!includeHidden && e.name.startsWith('.')) continue;
              const rel = join(relDir, e.name);
              if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name)) subdirs.push({ root, relDir: rel });
              } else if (e.isFile()) {
                if (filePattern && !e.name.endsWith(filePattern)) continue;
                const ext = extname(e.name) || e.name;
                if (TEXT_EXTS.has(ext) || TEXT_EXTS.has(e.name)) {
                  files.push({ root, relPath: rel });
                }
              }
            }
            return { subdirs, files };
          })
        );
        for (const r of dirResults) {
          pending.push(...r.subdirs);
          fileQueue.push(...r.files);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Search failed: ${message}` };
    }

    // ── Phase 2: stream-search files in parallel batches; stop early when full ──
    try {
      while (fileQueue.length > 0 && results.length < MAX_RESULTS) {
        const remaining = MAX_RESULTS - results.length;
        const batch = fileQueue.splice(0, CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(({ root, relPath }) =>
            searchFileStream(join(root, relPath), pattern, relPath, Math.min(3, remaining), regex)
          )
        );
        for (const matches of batchResults) {
          for (const m of matches) {
            if (results.length >= MAX_RESULTS) break;
            results.push(m);
          }
          if (results.length >= MAX_RESULTS) break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Search failed: ${message}` };
    }

    if (results.length === 0) {
      return { success: true, output: `No matches found for "${pattern}"` };
    }

    const truncated = results.length >= MAX_RESULTS && fileQueue.length > 0;
    return {
      success: true,
      output: results.join('\n') +
        (truncated ? `\n… (showing first ${MAX_RESULTS} matches, more files remain)` : ''),
    };
  },
};
