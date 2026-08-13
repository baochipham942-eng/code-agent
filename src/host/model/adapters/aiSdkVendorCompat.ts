import type { ModelConfig } from '../../../shared/contract';
import { resolveModelCapabilities } from '../modelCapabilityMatrix';

// ── 国内 thinking 模型（zhipu/moonshot/xiaomi）的 openai-compatible vendor quirks，迁自各 legacy
//    provider class 的 buildRequestBody。全部走 openai-compatible 官方支持的 settings：
//    includeUsage（stream_options.include_usage）/ headers / transformRequestBody（注入 vendor body 字段）。
//    reasoning_content 由 openai-compatible 原生映射成 reasoning-delta；zhipu 三态端点已由
//    resolveProviderBaseUrl 处理、并发 limiter 在 inferenceViaAiSdk 层套，故此处不重复。──
interface OpenAICompatVendorSettings {
  includeUsage?: boolean;
  headers?: Record<string, string>;
  transformRequestBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

export function buildVendorCompatSettings(config: ModelConfig, options?: { searchEnabled?: boolean }): OpenAICompatVendorSettings {
  switch (config.provider) {
    case 'zhipu':
      // GLM：仅 stream_options include_usage（并发 limiter 在 inferenceViaAiSdk 层，不在 body）。
      return { includeUsage: true };
    case 'deepseek':
      // DeepSeek thinking-mode：reasoning_effort 随 config 走（legacy DeepSeekProvider 有此映射，
      // 默认引擎此前没有——thinking/effort 逐轮设置在默认引擎上从未到过请求体，QE-01 真机抓获）。
      return config.reasoningEffort
        ? { transformRequestBody: (b) => ({ ...b, reasoning_effort: config.reasoningEffort }) }
        : {};
    case 'moonshot':
      // Kimi K2.5 thinking-mode 官方采样 temp=1.0/top_p=0.95 + 自报 UA（沿用 legacy MoonshotProvider）。
      return {
        includeUsage: true,
        headers: { 'User-Agent': 'claude-code/1.0' },
        transformRequestBody: (b) => ({
          ...b,
          temperature: b.temperature ?? 1.0,
          top_p: b.top_p ?? 0.95,
        }),
      };
    case 'qwen':
      // 百炼搜索的开关归能力矩阵所有；未声明的模型不可被默认开启。
      // 逐轮「联网搜索」开关是第二道闸：用户这一轮关了联网，矩阵裁决让位（默认 undefined = 开）。
      // 🔴 这里是 qwen 在【默认引擎】上的唯一注入点——legacy 的 qwenProvider.buildRequestBody
      // 只在 CODE_AGENT_MODEL_ENGINE=legacy 时才跑到，两处都要挂闸才算真接线。
      return options?.searchEnabled !== false
        && resolveModelCapabilities(config.provider, config.model).search?.mode === 'bailian-enable-search'
        ? {
          transformRequestBody: (b) => ({ ...b, enable_search: true }),
        }
        : {};
    case 'xiaomi': {
      // MiMo：thinking 字段（enabled/disabled 由 reasoningEffort/thinkingBudget 决定）+ 官方采样
      // temp=1.0/top_p=0.95 + 用 max_completion_tokens 而非 max_tokens（沿用 legacy XiaomiProvider）。
      const thinkingEnabled = config.reasoningEffort === 'high' || (config.thinkingBudget ?? 0) > 0;
      return {
        includeUsage: true,
        transformRequestBody: (b) => {
          const out: Record<string, unknown> = {
            ...b,
            temperature: b.temperature ?? 1.0,
            top_p: b.top_p ?? 0.95,
            thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
          };
          if (out.max_tokens != null && out.max_completion_tokens == null) {
            out.max_completion_tokens = out.max_tokens;
            delete out.max_tokens;
          }
          return out;
        },
      };
    }
    default:
      return {};
  }
}

// 返回类型交给推断：唯一的备选标注 SharedV4ProviderOptions 只存在于传递依赖
// @ai-sdk/provider 里，为一个类型标注去 package.json 直接依赖上游内部包不划算
// （knip-dependency-gate 也会红）。
export function resolveAiSdkProviderOptions(config: ModelConfig) {
  // 交给 @ai-sdk/anthropic 合并 beta header，避免手写 header 覆盖 SDK 的内置 beta。
  if (
    config.thinkingBudget
    && resolveModelCapabilities(config.provider, config.model).thinking?.interleaved
  ) {
    return {
      anthropic: {
        anthropicBeta: ['interleaved-thinking-2025-05-14'],
      },
    };
  }
  return undefined;
}
