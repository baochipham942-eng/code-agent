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
  deepseek: {
    models: {
      'deepseek-v4-flash': { protocol: 'responses', search: { mode: 'deepseek-responses' } },
    },
  },
  claude: {
    // interleaved thinking 是 Anthropic 的 beta header，逐模型放开——不写 default，
    // 免得未声明的老模型（claude-3 系）被误发不支持的 beta。
    models: {
      'claude-sonnet-4-6': { thinking: { interleaved: true } },
      'claude-opus-4-5-20251101': { thinking: { interleaved: true } },
      'claude-sonnet-4-5-20250929': { thinking: { interleaved: true } },
      'claude-opus-4-1-20250805': { thinking: { interleaved: true } },
      'claude-opus-4-20250514': { thinking: { interleaved: true } },
      'claude-sonnet-4-20250514': { thinking: { interleaved: true } },
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
