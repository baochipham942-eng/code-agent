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
export { XiaomiProvider } from './xiaomiProvider';

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
