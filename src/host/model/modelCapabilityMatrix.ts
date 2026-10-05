import type { ModelProvider } from '../../shared/contract/model';

export interface ModelCapabilityMatrixEntry {
  protocol: 'chat-completions' | 'responses' | 'anthropic-messages';
  search?: { mode: 'none' | 'deepseek-responses' | 'bailian-enable-search' };
  thinking?: { interleaved: boolean };
  /** chat-completions 请求体兼容开关；仅在明确声明的 (provider, model) 上改变默认请求形状。 */
  requestCompat?: {
    deepseekReasoningContent?: boolean;
    /** 端点明确拒绝 stream_options 时关闭 include_usage；未声明默认开启。 */
    noStreamOptions?: true;
  };
  /**
   * ADR-068 D1 断流续接能力分档（2026-09-14 核查，逐家附官方来源）。只有官方文档证实的
   * 档位可走 B1 无缝续接；`unknown` 一律 B2 兜底，不做运行时探针。按模型分档（claude
   * per-model 先例同 thinking.interleaved）。本刀只落数据，消费方在刀 1+ 接线。
   */
  streamResume?: {
    mode: 'prefix-param' | 'trailing-assistant' | 'none' | 'unknown';
    /**
     * prefix-param 档的端点路径覆盖：替换主端点（MODEL_API_ENDPOINTS）的 path 段，host 不变。
     * DeepSeek 官方 prefix 续写必须切 /beta（api-docs.deepseek.com/zh-cn/guides/chat_prefix_completion）。
     * 缺省（不声明）= 不切端点。
     */
    endpointPath?: string;
    /**
     * prefix-param 档的请求参数名（缺省 'prefix'）：
     * 'prefix' = DeepSeek 合同，顶层 body 键 prefix:true；
     * 'partial' = Moonshot Partial Mode，partial:true 打在末条 assistant 消息上
     * （platform.kimi.com/docs/guide/use-partial-mode-feature-of-kimi-api）。
     */
    param?: 'prefix' | 'partial';
  };
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
      // ADR-068 D1：官方对话前缀续写（Beta）——末条 assistant 消息 + prefix:true，
      // 但必须把端点从主端点切到 api.deepseek.com/beta（path 段覆盖，host 不变）。
      streamResume: { mode: 'prefix-param', endpointPath: '/beta' },
    },
    models: {
      'deepseek-flash': { protocol: 'responses', search: { mode: 'deepseek-responses' } },
      'deepseek-v4-flash': { protocol: 'responses', search: { mode: 'deepseek-responses' } },
    },
  },
  openai: {
    default: {
      // ADR-068 D1：无官方 prefix/续写参数（社区长期 feature request），部分模型直接
      // 拒绝末条 assistant prefill（「This model does not support assistant message prefill」）。
      streamResume: { mode: 'none' },
    },
    models: {
      // GPT-6 Sol 系列：官方要求工具调用走 Responses API（Chat Completions 仅限无工具
      // 调用），按模型切协议；模型页 2026-09-30：
      //   https://developers.openai.com/api/docs/models/gpt-6-sol
      //   https://developers.openai.com/api/docs/models/gpt-6.1-sol
      'gpt-6-sol': { protocol: 'responses' },
      'gpt-6.1-sol': { protocol: 'responses' },
    },
  },
  openrouter: {
    default: {
      // ADR-068 D1：官方 assistant prefill——messages 末尾 assistant 消息续写
      // （openrouter.ai/docs/api_reference/overview）。
      streamResume: { mode: 'trailing-assistant' },
    },
  },
  gemini: {
    default: {
      // ADR-068 D1：contents 末尾 model 角色可续写（社区/官方支持帖证实的事实标准，
      // 非一等文档合同）；thinking 模型续接须保留 thought signatures。
      streamResume: { mode: 'trailing-assistant' },
    },
  },
  moonshot: {
    default: {
      // ADR-068 follow-up（N-STREAM-RESUME-DOGFOOD，2026-09-30 真机探测，证据
      // N-STREAM-RESUME-DOGFOOD-2026-09-30.md）：官方 Partial Mode——末条 assistant
      // 消息带 partial:true 续写，标记打在消息上而非顶层 body，主端点不变。
      streamResume: { mode: 'prefix-param', param: 'partial' },
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
    // ADR-068 D1 streamResume 与其极性相反：prefill 官方文档化但 Claude 4.6+（含仓内默认
    // claude-opus-4-7、Mythos Preview）直接 400，故 default 落 none 兜住 4.6+ 与未声明模型，
    // 已证实的 ≤4.5 逐模型升 trailing-assistant（platform.claude.com working-with-messages）。
    default: {
      streamResume: { mode: 'none' },
    },
    models: {
      'claude-sonnet-4-6': { thinking: { interleaved: true } },
      'claude-opus-4-5-20251101': { thinking: { interleaved: true }, streamResume: { mode: 'trailing-assistant' } },
      'claude-haiku-4-5-20251001': { streamResume: { mode: 'trailing-assistant' } },
      'claude-sonnet-4-5-20250929': { thinking: { interleaved: true }, streamResume: { mode: 'trailing-assistant' } },
      'claude-opus-4-1-20250805': { thinking: { interleaved: true }, streamResume: { mode: 'trailing-assistant' } },
      'claude-opus-4-20250514': { thinking: { interleaved: true }, streamResume: { mode: 'trailing-assistant' } },
      'claude-sonnet-4-20250514': { thinking: { interleaved: true }, streamResume: { mode: 'trailing-assistant' } },
    },
  },
};

export function resolveModelCapabilities(provider: ModelProvider, modelId: string): ModelCapabilityMatrixEntry {
  const entry = MATRIX[provider];
  return {
    protocol: 'chat-completions',
    search: { mode: 'none' },
    thinking: { interleaved: false },
    // ADR-068 D1：未在矩阵声明的 provider/模型一律 unknown（B2 兜底），不假设可续接。
    streamResume: { mode: 'unknown' },
    responsesAtApiRoot: false,
    ...entry?.default,
    ...entry?.models?.[modelId],
  };
}
