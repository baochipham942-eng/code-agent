// ============================================================================
// DeepSeek Wrapper — DeepSeek/Kimi/Moonshot thinking-mode 模型的响应解析。
//
// DeepSeek/Kimi 协议本质是 OpenAI ChatCompletion 兼容 + `reasoning_content`
// （DeepSeek/GLM 风格）和 `reasoning`（Kimi 风格）字段。openaiWrapper 已经在
// MessageSchema / StreamDeltaSchema 里把这两个字段标为 optional，因此 wrapper
// 直接复用 OpenAI parser 即可。
//
// 这里独立成模块的目的：
//   1. 让 thinking-mode provider（deepseek.ts / deepseekProvider.ts / Moonshot
//      thinking / Kimi）import 路径明确，便于后续扩展（如 reasoning_signature）
//   2. 提供 reasoning 提取 helper，集中 reasoning_content / reasoning 别名处理
// ============================================================================
export {
  OpenAIChatCompletionSchema as DeepSeekChatCompletionSchema,
  OpenAIStreamChunkSchema as DeepSeekStreamChunkSchema,
  parseOpenAIResponse as parseDeepSeekResponse,
  parseOpenAIStreamChunk as parseDeepSeekStreamChunk,
} from './openaiWrapper';

export type {
  OpenAIChatCompletion as DeepSeekChatCompletion,
  OpenAIStreamChunk as DeepSeekStreamChunk,
  OpenAIStreamDelta as DeepSeekStreamDelta,
} from './openaiWrapper';

import type { OpenAIStreamDelta } from './openaiWrapper';

/**
 * 从 stream delta 提取 reasoning 文本，统一两种 provider 的字段名：
 * - DeepSeek / GLM: `reasoning_content`
 * - Kimi K2.5: `reasoning`
 *
 * 返回非空字符串或 undefined（无 reasoning 时）。
 */
export function extractReasoningDelta(delta: OpenAIStreamDelta | undefined): string | undefined {
  if (!delta) return undefined;
  return delta.reasoning_content || delta.reasoning || undefined;
}
