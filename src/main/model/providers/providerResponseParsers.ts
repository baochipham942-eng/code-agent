import type { ModelResponse } from '../types';
import { parseClaudeResponse as wrapperParseClaudeResponse } from './wrappers/anthropicWrapper';
import { parseGeminiResponse as wrapperParseGeminiResponse } from './wrappers/geminiWrapper';
import { parseOpenAIResponse as wrapperParseOpenAIResponse } from './wrappers/openaiWrapper';

/**
 * @deprecated 新代码请直接 import `./wrappers/openaiWrapper`.
 */
export function parseOpenAIResponse(data: unknown): ModelResponse {
  return wrapperParseOpenAIResponse(data);
}

/**
 * @deprecated 新代码请直接 import `./wrappers/anthropicWrapper`.
 */
export function parseClaudeResponse(data: unknown): ModelResponse {
  return wrapperParseClaudeResponse(data);
}

/**
 * @deprecated 新代码请直接 import `./wrappers/geminiWrapper`.
 */
export function parseGeminiResponse(data: unknown): ModelResponse {
  return wrapperParseGeminiResponse(data);
}
