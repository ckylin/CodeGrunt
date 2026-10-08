// ── Tool-call argument repair ───────────────────────────────────────────────
// Models (DeepSeek R1 especially) sometimes emit malformed JSON arguments:
// truncated strings, trailing commas, unquoted keys, markdown fences. Rather
// than failing the turn and forcing a cache-busting retry, salvage what we can,
// then validate against the tool's own schema (typo'd names, wrong types).

import { getToolRegistry } from './registry.js';

interface SchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
}

export interface ToolSchema {
  properties: Record<string, SchemaProperty>;
  required: string[];
}

/** The parameter schema a registered tool declares, or null for an unknown tool. */
export function getToolSchema(toolName: string): ToolSchema | null {
  const tool = getToolRegistry().getByName(toolName);
  const params = tool?.definition.function.parameters as Record<string, unknown> | undefined;
  if (!params || typeof params !== 'object') return null;
  return {
    properties: (params.properties as Record<string, SchemaProperty>) ?? {},
    required: (params.required as string[]) ?? [],
  };
}

/** Standard parse, then progressively more aggressive salvage strategies. */
function parseJsonWithFallback(argsJson: string): Record<string, unknown> | null {
  try {
    return JSON.parse(argsJson) as Record<string, unknown>;
  } catch { /* fall through */ }

  // Strip markdown fences
  const s = argsJson.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch { /* fall through */ }

  // Extract the first {...} block
  const braceMatch = s.match(/\{[\s\S]*\}/);
  if (!braceMatch) return null;
  try {
    return JSON.parse(braceMatch[0]) as Record<string, unknown>;
  } catch { /* fall through */ }

  // Fix trailing commas and unquoted keys
  const fixed = braceMatch[0]
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
  try {
    return JSON.parse(fixed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Closest valid key for a misspelled one: case-insensitive exact, then
 * prefix (ignoring `_`/`-`), then character overlap of at least 60%.
 */
function findClosestKey(input: string, validKeys: Set<string>): string | null {
  const lowerInput = input.toLowerCase();

  for (const key of validKeys) {
    if (key.toLowerCase() === lowerInput) return key;
  }

  const strip = (s: string) => s.replace(/[_-]/g, '');
  const inputNorm = strip(lowerInput);

  const prefixMatches = [...validKeys]
    .map((key) => ({ key, keyNorm: strip(key.toLowerCase()) }))
    .filter(({ keyNorm }) => keyNorm.startsWith(inputNorm))
    .map(({ key, keyNorm }) => ({ key, score: inputNorm.length / keyNorm.length }))
    .sort((a, b) => b.score - a.score);
  if (prefixMatches.length > 0) return prefixMatches[0].key;

  const inputChars = new Set(inputNorm);
  const overlapMatches = [...validKeys]
    .map((key) => {
      const keyChars = new Set(strip(key.toLowerCase()));
      const shared = [...inputChars].filter((c) => keyChars.has(c)).length;
      return { key, score: shared / Math.max(inputChars.size, keyChars.size) };
    })
    .filter(({ score }) => score >= 0.6)
    .sort((a, b) => b.score - a.score);
  return overlapMatches.length > 0 ? overlapMatches[0].key : null;
}

/**
 * Parse (and, given a tool name, schema-validate) tool arguments:
 * renames close typos, drops unknown keys, coerces number/boolean/string and
 * enum values. Returns null when nothing parses.
 */
export function repairToolArgs(argsJson: string, toolName?: string): Record<string, unknown> | null {
  const parsed = parseJsonWithFallback(argsJson);
  if (!parsed) return null;
  if (!toolName) return parsed;

  const schema = getToolSchema(toolName);
  if (!schema) return parsed;

  const schemaKeys = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(parsed)) {
    if (schemaKeys.has(key)) continue;
    const closest = findClosestKey(key, schemaKeys);
    if (closest) parsed[closest] = parsed[key];
    delete parsed[key];
  }

  for (const [key, value] of Object.entries(parsed)) {
    const prop = schema.properties[key];
    if (!prop || value === null || value === undefined) continue;

    if (prop.type === 'number' && typeof value === 'string') {
      const num = Number(value);
      if (!isNaN(num)) parsed[key] = num;
    } else if (prop.type === 'string' && typeof value === 'number') {
      parsed[key] = String(value);
    } else if (prop.type === 'boolean' && typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'true' || lower === 'yes') parsed[key] = true;
      else if (lower === 'false' || lower === 'no') parsed[key] = false;
    } else if (prop.enum && typeof value === 'string' && !prop.enum.includes(value)) {
      parsed[key] = prop.enum.find((e) => e.toLowerCase() === value.toLowerCase()) ?? prop.enum[0];
    }
  }

  return parsed;
}
