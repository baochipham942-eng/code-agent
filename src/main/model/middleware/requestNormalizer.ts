export interface NormalizedMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

export interface NormalizedToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Normalize messages for a specific provider.
 * Some providers only accept string content, others accept content-parts arrays.
 */
export function normalizeMessages(
  messages: Array<{ role: string; content: unknown }>,
  provider: string,
): NormalizedMessage[] {
  const STRING_ONLY_PROVIDERS = new Set(['zhipu', 'minimax', 'qwen', 'local']);

  return messages.map(msg => {
    let content = msg.content;

    if (STRING_ONLY_PROVIDERS.has(provider)) {
      // Flatten content-parts to string
      if (Array.isArray(content)) {
        content = (content as Array<{ type: string; text?: string }>)
          .filter(p => p.type === 'text')
          .map(p => p.text || '')
          .join('\n');
      }
    }

    return { role: msg.role, content: content as NormalizedMessage['content'] };
  });
}

/**
 * Convert internal tool format to provider-specific API schema.
 */
export function toolToAPISchema(
  tools: Array<{ name: string; description: string; parameters?: Record<string, unknown> }>,
  provider: string,
): NormalizedToolSchema[] {
  // OpenAI-style providers wrap in {type: 'function', function: {...}}
  // Anthropic-style providers use flat {name, description, input_schema}
  // For now, normalize to flat format (most providers accept this)
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters || {},
  }));
}

/**
 * Apply beta feature flags for models that support them.
 */
export function applyBetaFlags(
  model: string,
): string[] {
  const BETA_MODELS: Record<string, string[]> = {
    'claude-sonnet-4-6': ['prompt-caching-2024-07-31'],
    'claude-opus-4-6': ['prompt-caching-2024-07-31'],
  };
  return BETA_MODELS[model] || [];
}

/**
 * Determine if prompt cache should be active.
 * Lock cache eligibility to bootstrap state — don't flip mid-session.
 */
export function shouldEnableCache(
  isBootstrap: boolean,
  modelSupportsCache: boolean,
): boolean {
  return isBootstrap && modelSupportsCache;
}
