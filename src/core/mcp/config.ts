// ── MCP Config Store ──────────────────────────────────────────────────────
// Persists MCP server configurations to ~/.codegrunt/mcp.json

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { McpServerConfig } from './types.js';

const CONFIG_DIR = join(homedir(), '.codegrunt');
const MCP_CONFIG_PATH = join(CONFIG_DIR, 'mcp.json');

export interface McpConfig {
  servers: McpServerConfig[];
}

export async function loadMcpConfig(): Promise<McpConfig> {
  if (!existsSync(MCP_CONFIG_PATH)) return { servers: [] };
  try {
    const raw = await readFile(MCP_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as McpConfig;
  } catch {
    return { servers: [] };
  }
}

export async function saveMcpConfig(config: McpConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export async function addMcpServer(server: McpServerConfig): Promise<void> {
  const config = await loadMcpConfig();
  config.servers = config.servers.filter(s => s.name !== server.name);
  config.servers.push(server);
  await saveMcpConfig(config);
}

export async function removeMcpServer(name: string): Promise<boolean> {
  const config = await loadMcpConfig();
  const before = config.servers.length;
  config.servers = config.servers.filter(s => s.name !== name);
  if (config.servers.length === before) return false;
  await saveMcpConfig(config);
  return true;
}
