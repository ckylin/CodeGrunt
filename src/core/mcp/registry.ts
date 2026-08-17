// ── MCP Server Registry Search ────────────────────────────────────────────
// Queries the official MCP Registry (https://registry.modelcontextprotocol.io)
// to help users discover installable MCP servers by keyword, without leaving
// CodeGrunt. Read-only — never installs anything automatically; the caller
// (/mcp search) prints a suggested `/mcp add` command for the user to run.
//
// Registry API reference: https://github.com/modelcontextprotocol/registry
//   GET /v0.1/servers?search=<substring>&version=latest&limit=<n>
//   Response: { servers: [{ server: { name, description, packages?, remotes? } }] }
//   - `packages`: installable via a package manager (npm/pip/etc), run as a
//     local stdio subprocess. Each entry has registryType/identifier/transport.
//   - `remotes`: a directly connectable network endpoint (sse / streamable-http).

import { getLogger } from '../observability/logger.js';

const log = getLogger('mcp:registry');

const REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io';
const REQUEST_TIMEOUT_MS = 10_000;

// ── Registry response shape (partial — only the fields we use) ───────────

interface RegistryPackage {
  registryType?: string;
  registryBaseUrl?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type?: string };
}

interface RegistryRemote {
  type?: string;
  url?: string;
}

interface RegistryServerEntry {
  name?: string;
  description?: string;
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

interface RegistryResponse {
  servers?: Array<{ server?: RegistryServerEntry }>;
}

// ── Public result shape ───────────────────────────────────────────────────

export type McpSearchInstall =
  | { kind: 'stdio'; command: string; args: string[] }
  | { kind: 'remote'; transport: 'sse' | 'streamable-http'; url: string }
  | { kind: 'unknown' };

export interface McpSearchResult {
  name: string;
  description: string;
  install: McpSearchInstall;
}

// ── Install suggestion derivation ─────────────────────────────────────────

/**
 * Pick the best install method from a registry entry: prefer a directly
 * connectable remote endpoint (no local process to manage) over a package
 * that has to be launched locally via a package manager runner.
 */
function deriveInstall(entry: RegistryServerEntry): McpSearchInstall {
  for (const remote of entry.remotes ?? []) {
    if (remote.type === 'streamable-http' && remote.url) {
      return { kind: 'remote', transport: 'streamable-http', url: remote.url };
    }
    if (remote.type === 'sse' && remote.url) {
      return { kind: 'remote', transport: 'sse', url: remote.url };
    }
  }

  for (const pkg of entry.packages ?? []) {
    if (pkg.registryType === 'npm' && pkg.identifier) {
      return { kind: 'stdio', command: 'npx', args: ['-y', pkg.identifier] };
    }
  }

  return { kind: 'unknown' };
}

// ── Search ─────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search the official MCP registry for servers matching `query` (case-insensitive
 * substring match on server name, per the registry's documented `search` param).
 * Returns an empty array on any network/parse failure — search is a discovery
 * aid, not a critical path, so callers should just show "no results" on failure.
 */
export async function searchMcpRegistry(query: string, limit = 10): Promise<McpSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const url = `${REGISTRY_BASE_URL}/v0.1/servers?search=${encodeURIComponent(trimmed)}&version=latest&limit=${limit}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    log.warn('MCP registry search failed (network)', { query: trimmed, error: err instanceof Error ? err.message : String(err) });
    return [];
  }

  if (!res.ok) {
    log.warn('MCP registry search failed (HTTP status)', { query: trimmed, status: res.status });
    return [];
  }

  let data: RegistryResponse;
  try {
    data = await res.json() as RegistryResponse;
  } catch (err) {
    log.warn('MCP registry search failed (invalid JSON)', { query: trimmed, error: err instanceof Error ? err.message : String(err) });
    return [];
  }

  const entries = (data.servers ?? [])
    .map(s => s.server)
    .filter((s): s is RegistryServerEntry => !!s && !!s.name);

  return entries.slice(0, limit).map(entry => ({
    name: entry.name!,
    description: entry.description ?? '',
    install: deriveInstall(entry),
  }));
}
