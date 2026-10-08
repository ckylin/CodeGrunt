// Provider-specific model knowledge in one place. Callers ask "is this a
// reasoner?" or "what is the cheap model for this one?" instead of matching
// DeepSeek model-id strings themselves.

export const DEEPSEEK_FAST_MODEL = 'deepseek-v4-flash';
export const DEEPSEEK_PRO_MODEL = 'deepseek-v4-pro';

export function isDeepSeekModel(model: string): boolean {
  return model.startsWith('deepseek-');
}

/** DeepSeek V4 family (flash/pro): the only tier model auto-routing may switch within. */
export function isDeepSeekV4Model(model: string): boolean {
  return model.startsWith('deepseek-v4-');
}

/**
 * Cheapest model for structured side tasks (classification, planning,
 * summarization, sub-agents). Flash for DeepSeek; any other provider keeps
 * whatever is configured.
 */
export function fastModelFor(configuredModel: string): string {
  return isDeepSeekModel(configuredModel) ? DEEPSEEK_FAST_MODEL : configuredModel;
}

/**
 * Detect whether the current model is a DeepSeek "pure" reasoner (R1) model.
 * R1 models do NOT support `temperature`, reject the `system` role, and
 * require the system prompt to be embedded in the first user message.
 */
export function isReasonerModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('reasoner') || lower.includes('r1');
}

/**
 * Detect whether the model supports reasoning/thinking capabilities
 * (emits reasoning_content, supports reasoning_effort parameter).
 * This includes R1 reasoner models AND V4 Pro models.
 */
export function supportsReasoning(model: string): boolean {
  const lower = model.toLowerCase();
  return isReasonerModel(model)
    || lower.includes('v4')
    || lower.includes('pro');
}
