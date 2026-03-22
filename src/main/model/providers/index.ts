// ============================================================================
// Provider Exports
// ============================================================================

// New Provider interface implementations
export { MoonshotProvider } from './moonshotProvider';
export { GroqProvider } from './groqProvider';
export { QwenProvider } from './qwenProvider';
export { MinimaxProvider } from './minimaxProvider';
export { PerplexityProvider } from './perplexityProvider';
export { LocalProvider } from './localProvider';
export { OpenAIProvider } from './openaiProvider';
export { DeepSeekProvider } from './deepseekProvider';
export { OpenRouterProvider } from './openrouterProvider';
export { ZhipuProvider } from './zhipuProvider';
export { ClaudeProvider } from './claudeProvider';
export { GeminiProvider } from './geminiProvider';

// Cloud Proxy (special case, called before provider dispatch)
export { callViaCloudProxy } from './cloud-proxy';

// Legacy functions (kept for backward compatibility, will be removed after validation)
export { callDeepSeek } from './deepseek';
export { callClaude } from './anthropic';
export { callOpenAI, callGroq, callLocal, callQwen, callMinimax, callPerplexity } from './openai-compatible';
export { callMoonshot } from './moonshot';
export { callGemini } from './gemini';
export { callZhipu } from './zhipu';
export { callOpenRouter } from './openrouter';

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
  convertToTextOnlyMessages,
  convertToGeminiMessages,
  safeJsonParse,
  parseOpenAIResponse,
  parseClaudeResponse,
  parseGeminiResponse,
  handleGeminiStream,
} from './shared';
