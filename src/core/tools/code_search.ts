// ── Code Search Tool ──────────────────────────────────────────────────────
// Semantic symbol search using the local code index built by /index.
// Falls back to grep-based search if no index exists.

import type { Tool, ToolResult } from '../../types.js';
import { loadIndex, searchIndex, type CodeSymbol } from '../index/index.js';
import { getLogger } from '../observability/logger.js';

const log = getLogger('tools:code_search');

const VALID_KINDS: ReadonlySet<string> = new Set(['function', 'class', 'interface', 'type', 'export', 'const', 'variable']);

export const codeSearchTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'code_search',
      description: 'Search the codebase for symbols (functions, classes, types, exports) by name. Faster and more accurate than search_files for finding definitions. Requires /index to have been run first; falls back to a note if no index exists.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Symbol name or partial name to search for (e.g. "getUserById", "AuthService", "UserType")',
          },
          kind: {
            type: 'string',
            description: 'Filter by symbol kind: function | class | interface | type | export | const | variable',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results (default: 10)',
          },
        },
        required: ['query'],
      },
    },
  },

  async execute(args): Promise<ToolResult> {
    const query = args['query'] as string;
    const kind = args['kind'] as string | undefined;
    const maxResults = Math.min(20, (args['max_results'] as number | undefined) ?? 10);
    const cwd = process.cwd();

    log.info('Code search', { query, kind });

    const index = await loadIndex(cwd);
    if (!index) {
      return {
        success: true,
        output: `No code index found for this project. Run /index to build one first.\n\nFallback: use search_files with pattern "${query}" to find references manually.`,
      };
    }

    const validKind = kind && VALID_KINDS.has(kind) ? (kind as CodeSymbol['kind']) : undefined;
    const hits = searchIndex(index, query, maxResults, validKind);

    if (hits.length === 0) {
      return {
        success: true,
        output: `No symbols matching "${query}"${kind ? ` (kind: ${kind})` : ''} found in index.\n\nIndex contains ${index.symbols.length} symbols across ${index.files.length} files.\nBuilt: ${new Date(index.builtAt).toLocaleString()}`,
      };
    }

    const lines = hits.map(h =>
      `${h.symbol.file}:${h.symbol.line}  [${h.symbol.kind}]  ${h.symbol.name}`
    );

    return {
      success: true,
      output: `Found ${hits.length} result${hits.length > 1 ? 's' : ''} for "${query}":\n\n${lines.join('\n')}\n\nIndex: ${index.symbols.length} symbols, built ${new Date(index.builtAt).toLocaleString()}`,
    };
  },
};
