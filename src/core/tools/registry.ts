// ── Harness-style Tool Registry (Plugin Architecture) ─────────────────────
// Tools are registered as plugins with lifecycle hooks.
// The registry supports dynamic registration, so tools can be added/removed
// at runtime (e.g., by skills or extensions).
//
// Ref: Original static registry at src/core/tools/registry.ts

import type { Tool, ToolDefinition } from '../../types.js';
import { readFileTool } from './read_file.js';
import { writeFileTool } from './write_file.js';
import { editFileTool } from './edit_file.js';
import { executeShellTool } from './execute_shell.js';
import { listDirectoryTool } from './list_directory.js';
import { searchFilesTool } from './search_files.js';
import { memoryWriteTool, memoryReadTool } from './memory.js';
import { webSearchTool } from './web_search.js';
import { codeSearchTool } from './code_search.js';
import { agentOpenTool } from './agent_open.js';
import { getLogger } from '../observability/logger.js';

const log = getLogger('tools:registry');

// ── Registry ─────────────────────────────────────────────────────────────

interface ToolRegistration {
  tool: Tool;
  /** When the tool was registered */
  registeredAt: number;
  /** Source: 'builtin' | 'skill' | 'extension' */
  source: string;
}

class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  constructor() {
    this.registerBuiltins();
  }

  /** Register a tool */
  register(tool: Tool, source = 'extension'): void {
    const name = tool.definition.function.name;
    this.tools.set(name, { tool, registeredAt: Date.now(), source });
    log.debug(`Tool registered: ${name} (${source})`);
  }

  /** Unregister a tool */
  unregister(name: string): boolean {
    const existed = this.tools.delete(name);
    if (existed) log.debug(`Tool unregistered: ${name}`);
    return existed;
  }

  /** Get all tools */
  getAll(): Tool[] {
    return Array.from(this.tools.values()).map(r => r.tool);
  }

  /** Get all tool definitions (for LLM function calling) */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(r => r.tool.definition);
  }

  /** Get a specific tool by name */
  getByName(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  /** Check if a tool is registered */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** List all registered tool names with sources */
  listNames(): Array<{ name: string; source: string }> {
    return Array.from(this.tools.entries()).map(([name, reg]) => ({
      name,
      source: reg.source,
    }));
  }

  /** Number of registered tools */
  get size(): number {
    return this.tools.size;
  }

  /** Register built-in tools */
  private registerBuiltins(): void {
    const builtins = [
      readFileTool,
      writeFileTool,
      editFileTool,
      executeShellTool,
      listDirectoryTool,
      searchFilesTool,
      memoryWriteTool,
      memoryReadTool,
      webSearchTool,
      codeSearchTool,
      agentOpenTool,
    ];
    for (const tool of builtins) {
      this.register(tool, 'builtin');
    }
  }
}

// ── Backward-compatible exports (used by existing code) ──────────────────

let defaultRegistry: ToolRegistry | null = null;

function getToolRegistry(): ToolRegistry {
  if (!defaultRegistry) defaultRegistry = new ToolRegistry();
  return defaultRegistry;
}

export function getToolDefinitions(): ToolDefinition[] {
  return getToolRegistry().getDefinitions();
}

export function getToolByName(name: string): Tool | undefined {
  return getToolRegistry().getByName(name);
}

export { getToolRegistry };
