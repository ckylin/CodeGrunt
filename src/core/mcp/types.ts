// ── MCP Types ─────────────────────────────────────────────────────────────

export type McpTransport = 'stdio' | 'sse' | 'streamable-http';

export interface McpServerConfig {
  name: string;
  transport: McpTransport;
  /** For stdio: the command to run (e.g. "npx @modelcontextprotocol/server-filesystem") */
  command?: string;
  /** Args for stdio transport */
  args?: string[];
  /** For SSE and Streamable HTTP: the URL to connect to */
  url?: string;
  /** Optional env vars to pass to stdio process */
  env?: Record<string, string>;
}

export interface McpServerState {
  config: McpServerConfig;
  status: 'connected' | 'disconnected' | 'error';
  toolNames: string[];
  error?: string;
}
