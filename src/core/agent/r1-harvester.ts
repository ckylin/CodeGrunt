// ── R1 Thought Harvesting (v0.6) ────────────────────────────────────────────
//
// When DeepSeek R1 (or any reasoner model) is processing a task, it may
// "think out loud" in the reasoning_content field. Occasionally, the model
// will describe a tool call it wants to make within its reasoning block
// but then fail to emit it as a formal tool_call in the response.
//
// This module scans the reasoning_content for patterns like:
//   tool_name({...})
//   I should use tool_name with args...
//   Let me call tool_name(params)
//
// And extracts them as structured tool call candidates that can be
// automatically injected into the response.
//
// Pattern: the model often writes tool calls as JSON-like blocks within
// its chain-of-thought, e.g.:
//   "I need to read the file: read_file({ "path": "src/index.ts" })"
//   "Let me search: search_files({ "pattern": "auth", "path": "src/" })"

const TOOL_CALL_PATTERN = /(?:use\s+|call\s+|run\s+)?(\w+)\s*\(\s*\{([\s\S]*?)\}\s*\)/g;

// Known tool names in CodeGrunt — used to filter false positives
const KNOWN_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'edit_file', 'execute_shell',
  'list_directory', 'search_files', 'web_search', 'code_search',
  'agent_open', 'memory_write', 'memory_read',
]);

interface HarvestedToolCall {
  name: string;
  args: Record<string, unknown>;
  /** The raw text that was matched (for logging) */
  raw: string;
  /** Confidence score 0-1 */
  confidence: number;
}

/**
 * Scan reasoning_content for escaped tool call patterns.
 * Returns an array of potential tool calls that were found.
 *
 * @param reasoningContent The reasoning_content string from the model response
 * @returns Array of harvested tool calls, sorted by position in text
 */
export function harvestToolCalls(reasoningContent: string): HarvestedToolCall[] {
  if (!reasoningContent || reasoningContent.trim().length === 0) {
    return [];
  }

  const results: HarvestedToolCall[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  TOOL_CALL_PATTERN.lastIndex = 0;

  while ((match = TOOL_CALL_PATTERN.exec(reasoningContent)) !== null) {
    const toolName = match[1].trim();
    const argsBody = match[2].trim();
    const fullMatch = match[0];

    // Skip if not a known tool
    if (!KNOWN_TOOL_NAMES.has(toolName)) {
      continue;
    }

    // Try to parse the arguments as JSON (with repair)
    let parsedArgs: Record<string, unknown> | null = null;

    // First try direct JSON parse
    try {
      parsedArgs = JSON.parse(`{${argsBody}}`) as Record<string, unknown>;
    } catch {
      // Try with repair: fix trailing commas and unquoted keys
      try {
        const fixed = `{${argsBody}}`
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
        parsedArgs = JSON.parse(fixed) as Record<string, unknown>;
      } catch {
        // Could not parse — skip this match
        continue;
      }
    }

    if (parsedArgs) {
      // Verify it has at least the required params for the tool
      if (hasRequiredParams(toolName, parsedArgs)) {
        results.push({
          name: toolName,
          args: parsedArgs,
          raw: fullMatch,
          // Higher confidence for well-formed JSON with all required params
          confidence: 0.9,
        });
      } else {
        // Partial match — lower confidence
        results.push({
          name: toolName,
          args: parsedArgs,
          raw: fullMatch,
          confidence: 0.5,
        });
      }
    }
  }

  return results;
}

/**
 * Check if the parsed args contain the minimum required parameters
 * for the given tool.
 */
function hasRequiredParams(toolName: string, args: Record<string, unknown>): boolean {
  const required: Record<string, string[]> = {
    read_file: ['path'],
    write_file: ['path', 'content'],
    edit_file: ['path', 'old_string', 'new_string'],
    execute_shell: ['command'],
    list_directory: ['path'],
    search_files: ['pattern'],
    web_search: ['query'],
    code_search: ['query'],
    agent_open: ['task'],
    memory_write: ['name', 'type', 'description', 'body'],
    memory_read: [],
  };

  const needed = required[toolName];
  if (!needed) return false;

  return needed.every(p => args[p] !== undefined && args[p] !== null);
}

/**
 * Deduplicate harvested tool calls, keeping only the highest-confidence
 * match for each unique (toolName, argKey) pair.
 */
export function deduplicateHarvested(calls: HarvestedToolCall[]): HarvestedToolCall[] {
  const seen = new Map<string, HarvestedToolCall>();

  for (const call of calls) {
    // Create a dedup key: toolName + first argument value
    const firstArg = Object.values(call.args)[0];
    const key = `${call.name}:${String(firstArg ?? '')}`;

    const existing = seen.get(key);
    if (!existing || call.confidence > existing.confidence) {
      seen.set(key, call);
    }
  }

  return Array.from(seen.values());
}

/**
 * Check if the harvested tool calls overlap with the actual tool calls
 * already emitted by the model. Returns only the truly "escaped" calls
 * that the model thought about but didn't formally invoke.
 */
export function filterNonEscaped(
  harvested: HarvestedToolCall[],
  actualToolCalls: Array<{ name: string; args: string }>,
): HarvestedToolCall[] {
  if (actualToolCalls.length === 0) return harvested;

  const actualSet = new Set<string>();
  for (const tc of actualToolCalls) {
    const firstArg = extractFirstArgValue(tc.args);
    actualSet.add(`${tc.name}:${firstArg}`);
  }

  return harvested.filter(h => {
    const firstArg = Object.values(h.args)[0];
    const key = `${h.name}:${String(firstArg ?? '')}`;
    return !actualSet.has(key);
  });
}

function extractFirstArgValue(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    const val = Object.values(parsed)[0];
    return String(val ?? '');
  } catch {
    return '';
  }
}
