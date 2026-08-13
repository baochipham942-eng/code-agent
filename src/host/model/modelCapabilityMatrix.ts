import type { ModelProvider } from '../../shared/contract/model';

export interface ModelCapabilityMatrixEntry {
  protocol: 'chat-completions' | 'responses' | 'anthropic-messages';
  search?: { mode: 'none' | 'deepseek-responses' | 'bailian-enable-search' };
  thinking?: { interleaved: boolean };
  /** chat-completions 请求体的历史消息兼容字段；仅在明确声明的 (provider, model) 上发送。 */
  requestCompat?: { deepseekReasoningContent: boolean };
  /** Responses 端点是否在 API 根（true 时剥掉 baseUrl 末尾的 /vN）；默认 false = 端点在 baseUrl 之下的 /responses。 */
  responsesAtApiRoot?: boolean;
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
    default: {
      // 官方 DeepSeek 的 Responses 在 API 根（api.deepseek.com/responses），不在 /v1 下。
      responsesAtApiRoot: true,
      // DeepSeek 要求历史中每条 assistant 消息都回传 reasoning_content（可以为空）。
      requestCompat: { deepseekReasoningContent: true },
      // DeepSeek 要求历史中每条 assistant 消息都回传 reasoning_content（可以为空）。
    },
    models: {
      'deepseek-v4-flash': { protocol: 'responses', search: { mode: 'deepseek-responses' } },
    },
  },
  'custom-tokenrhythm': {
    models: {
      // 2026-08-13 实测：仅 0731 支持 Responses + web_search；
      // 同名的 deepseek-v4-flash / -pro 均被上游拒绝，不可想当然继承官方。
      'deepseek-v4-flash-0731': { protocol: 'responses', search: { mode: 'deepseek-responses' } },
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
    responsesAtApiRoot: false,
    ...entry?.default,
    ...entry?.models?.[modelId],
  };
}
