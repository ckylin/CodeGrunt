import OpenAI from 'openai';
import type { CodeGruntConfig } from '../../types.js';

export function createOpenAIClient(config: CodeGruntConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    // openai SDK defaults to a 10-minute timeout — too long to hang silently
    // on a stalled stream. 3 minutes gives large-context calls room while
    // still surfacing a clear error instead of an indefinite freeze.
    timeout: 180_000,
  });
}

/**
 * Validates an API key by hitting the /models endpoint.
 * Returns null on success, or an error message string on failure.
 */
export async function validateApiKey(apiKey: string, baseURL: string): Promise<string | null> {
  const client = new OpenAI({ apiKey, baseURL });
  try {
    await client.models.list();
    return null;
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      if (err.status === 401) return 'Invalid API key (authentication failed).';
      return `API error ${err.status}: ${err.message}`;
    }
    return `Network error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
