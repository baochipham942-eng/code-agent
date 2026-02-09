// ============================================================================
// Provider Exports
// ============================================================================

// DeepSeek
export { callDeepSeek } from './deepseek';

// Anthropic
export { callClaude } from './anthropic';

// OpenAI-compatible providers
export {
  callOpenAI,
  callGroq,
  callLocal,
  callQwen,
  callMinimax,
  callPerplexity,
} from './openai-compatible';

// Moonshot (Kimi) - 使用原生 SSE 处理
export { callMoonshot } from './moonshot';

// Gemini
export { callGemini } from './gemini';

// 智谱
export { callZhipu } from './zhipu';

// OpenRouter
export { callOpenRouter } from './openrouter';

// Cloud Proxy
export { callViaCloudProxy } from './cloud-proxy';

// Shared utilities
export {
  logger,
  httpsAgent,
  electronFetch,
  parseContextLengthError,
  normalizeJsonSchema,
  convertToolsToOpenAI,
  convertToolsToClaude,
  convertToOpenAIMessages,
  convertToClaudeMessages,
  convertToGeminiMessages,
  safeJsonParse,
  parseOpenAIResponse,
  parseClaudeResponse,
  parseGeminiResponse,
  handleGeminiStream,
} from './shared';
