import type { ModelProvider } from '../../shared/contract/model';

export interface ModelCapabilityMatrixEntry {
  protocol: 'chat-completions' | 'responses' | 'anthropic-messages';
  search?: { mode: 'none' | 'deepseek-responses' | 'bailian-enable-search' };
  thinking?: { interleaved: boolean };
}

type ModelCapabilityMatrix = Partial<Record<
  ModelProvider,
  { default?: Partial<ModelCapabilityMatrixEntry>; models?: Record<string, Partial<ModelCapabilityMatrixEntry>> }
>>;

const MATRIX: ModelCapabilityMatrix = {
  qwen: {
    default: {
      search: { mode: 'bailian-enable-search' },
    },
  },
};

export function resolveModelCapabilities(provider: ModelProvider, modelId: string): ModelCapabilityMatrixEntry {
  const entry = MATRIX[provider];
  return {
    protocol: 'chat-completions',
    search: { mode: 'none' },
    thinking: { interleaved: false },
    ...entry?.default,
    ...entry?.models?.[modelId],
  };
}
