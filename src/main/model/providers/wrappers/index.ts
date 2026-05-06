// ============================================================================
// Provider Wrappers — zod schema + parse 函数。
//
// 设计原则（plan §4）：
//   - 每个 provider family（OpenAI / Anthropic / Gemini）一个 wrapper
//   - DeepSeek/Kimi/Moonshot thinking-mode 复用 OpenAI wrapper
//   - schema 用 .passthrough() 容忍未知字段，hot path safeParse + 降级
// ============================================================================

export {
  OpenAIChatCompletionSchema,
  OpenAIStreamChunkSchema,
  parseOpenAIResponse,
  parseOpenAIStreamChunk,
} from './openaiWrapper';
export type {
  OpenAIChatCompletion,
  OpenAIChoice,
  OpenAIMessage,
  OpenAIStreamChunk,
  OpenAIStreamChoice,
  OpenAIStreamDelta,
  OpenAIToolCallDelta,
} from './openaiWrapper';

export {
  ClaudeMessageSchema,
  parseClaudeResponse,
  parseClaudeSSEEvent,
} from './anthropicWrapper';
export type {
  ClaudeMessage,
  ClaudeContentBlock,
  ClaudeContentBlockDelta,
  ClaudeSSEEvent,
} from './anthropicWrapper';

export {
  DeepSeekChatCompletionSchema,
  DeepSeekStreamChunkSchema,
  parseDeepSeekResponse,
  parseDeepSeekStreamChunk,
  extractReasoningDelta,
} from './deepseekWrapper';
export type {
  DeepSeekChatCompletion,
  DeepSeekStreamChunk,
  DeepSeekStreamDelta,
} from './deepseekWrapper';

export {
  GeminiResponseSchema,
  parseGeminiResponse,
  parseGeminiStreamChunk,
} from './geminiWrapper';
export type {
  GeminiResponse,
  GeminiCandidate,
  GeminiPart,
} from './geminiWrapper';
