import { PROVIDER_FALLBACK_CHAIN } from '../../shared/constants';
import type { ModelProvider } from '../../shared/contract';
import { needsArtifactTaskBrief } from '../prompts/artifactGeneration';
import type { InferenceOptions, ModelMessage, StreamCallback } from './types';

export type ProviderFallbackCategory =
  | 'timeout'
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'provider_unavailable'
  | 'network'
  | 'artifact_response'
  | 'model'
  | 'unknown';

export interface ProviderFallbackTarget {
  provider: string;
  model: string;
}

export const PERSISTENT_PROVIDER_ERROR_PATTERN =
  /401|403|unauthorized|forbidden|incorrect api key|invalid[_ ]api[_ ]key|model_not_allowed|subscription plan does not include access|insufficient balance|余额不足/i;

export const ARTIFACT_UNUSABLE_RESPONSE_PATTERN = /empty artifact response/i;

const ARTIFACT_FALLBACK_PRIORITY = new Map([
  ['zhipu', 0],
  ['deepseek', 1],
  ['openai', 2],
  ['moonshot', 3],
]);

export function classifyProviderFallbackReason(
  message: string,
  code?: string,
): ProviderFallbackCategory {
  const normalized = `${message} ${code || ''}`.toLowerCase();
  if (/timeout|timed out|etimedout|first-byte timeout|inactivity timeout/.test(normalized)) return 'timeout';
  if (/429|rate.?limit|too many requests|requests per minute/.test(normalized)) return 'rate_limit';
  if (/402|insufficient[_ ]quota|insufficient balance|payment required|quota exceeded|billing|credit|余额不足/.test(normalized)) return 'quota';
  if (/401|403|unauthorized|forbidden|invalid[_ ]api[_ ]key|invalid token|authentication/.test(normalized)) return 'auth';
  if (/no available accounts|503|502|504|service unavailable|bad gateway|gateway timeout|overloaded|capacity/.test(normalized)) return 'provider_unavailable';
  if (/econnreset|econnrefused|enotfound|eai_again|socket hang up|socket disconnected|secure tls connection|network request failed|network error|fetch failed/.test(normalized)) return 'network';
  if (ARTIFACT_UNUSABLE_RESPONSE_PATTERN.test(message)) return 'artifact_response';
  if (/reasoning loop detected|repetitive reasoning|model degeneration/.test(normalized)) return 'model';
  if (/model_not_allowed|model.*(?:deprecated|decommissioned|retired|not found|does not exist)/.test(normalized)) return 'model';
  return 'unknown';
}

export function formatFallbackReason(message: string): string {
  return message.split('\n')[0]?.slice(0, 240) || 'unknown';
}

export function getFallbackChainForRequest(
  messages: ModelMessage[],
  provider: ModelProvider,
): ProviderFallbackTarget[] {
  const chain = PROVIDER_FALLBACK_CHAIN[provider];
  if (!chain || chain.length === 0) return [];
  if (!isArtifactLikeRequest(messages)) return chain;

  return [...chain].sort((a, b) => {
    const aRank = ARTIFACT_FALLBACK_PRIORITY.get(a.provider) ?? 99;
    const bRank = ARTIFACT_FALLBACK_PRIORITY.get(b.provider) ?? 99;
    return aRank - bRank;
  });
}

export function shouldRetryArtifactNonStreaming(
  messages: ModelMessage[],
  err: unknown,
  onStream?: StreamCallback,
  signal?: AbortSignal,
  options?: InferenceOptions,
): boolean {
  if (!onStream) return false;
  if (signal?.aborted) return false;
  if (options?.forceNonStreaming === true) return false;
  if (!isArtifactLikeRequest(messages)) return false;
  if (hasArtifactRepairToolBlockedMarker(messages)) return false;

  const errMsg = err instanceof Error ? err.message : String(err);
  return /stream inactivity timeout|first-byte timeout|流式响应无内容|stream ended before \[DONE\]|refusing to execute incomplete tool arguments|invalid streamed tool arguments/i.test(errMsg);
}

export function shouldKeepArtifactRequestOnSelectedProvider(
  messages: ModelMessage[],
  fallbackCategory: ProviderFallbackCategory,
): boolean {
  if (!isArtifactLikeRequest(messages)) return false;
  return fallbackCategory !== 'quota'
    && fallbackCategory !== 'auth'
    && fallbackCategory !== 'model'
    && fallbackCategory !== 'artifact_response';
}

export function shouldRetrySelectedArtifactProvider(
  fallbackCategory: ProviderFallbackCategory,
  options?: InferenceOptions,
): boolean {
  return fallbackCategory === 'provider_unavailable'
    || fallbackCategory === 'network'
    || fallbackCategory === 'rate_limit'
    || (fallbackCategory === 'timeout' && options?.artifactRepairActive === true);
}

export function shouldAllowArtifactFallbackAfterSelectedRetry(
  fallbackCategory: ProviderFallbackCategory,
  options?: InferenceOptions,
): boolean {
  return options?.artifactRepairActive === true
    && shouldRetrySelectedArtifactProvider(fallbackCategory, options);
}

export function isArtifactLikeRequest(messages: ModelMessage[]): boolean {
  if (hasArtifactRepairContextMarker(messages)) return true;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;

    const text = extractMessageText(message);
    if (needsArtifactTaskBrief(text)) return true;
  }
  return false;
}

export function hasArtifactRepairContextMarker(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    const text = extractMessageText(message);
    return text.includes('<artifact-validation-failed')
      || text.includes('<artifact-repair-')
      || text.includes('<tool-admission-repair>')
      || text.includes('Artifact validation failed for ');
  });
}

export function shouldPreferNonStreamingArtifactFileTurn(
  messages: ModelMessage[],
  onStream?: StreamCallback,
  options?: InferenceOptions,
): boolean {
  if (!onStream) return false;
  if (options?.forceNonStreaming === true) return false;
  if (!isArtifactLikeRequest(messages)) return false;
  return hasExplicitFileArtifactIntent(messages);
}

export function hasArtifactRepairToolBlockedMarker(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== 'system' && message.role !== 'tool') return false;
    const text = extractMessageText(message);
    return text.includes('<artifact-repair-recovery>')
      || text.includes('<artifact-repair-admission-blocked>')
      || text.includes('<artifact-repair-tool-blocked>');
  });
}

export function hasArtifactValidationFailureMarker(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== 'system' && message.role !== 'tool') return false;
    const text = extractMessageText(message);
    return text.includes('<artifact-validation-failed');
  });
}

export function hasExplicitFileArtifactIntent(messages: ModelMessage[]): boolean {
  const explicitFileIntentPattern = /保存到|写到|写入|输出到|生成到|单文件|single[-\s]?file|\.html\b|\.tsx?\b|\.jsx?\b|\.css\b|\.md\b|\/[\w.-]+|\\[\w .-]+|file path|save (it )?to|write (it )?to/i;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user' && message.role !== 'system') continue;
    const text = extractMessageText(message);
    if (!text) continue;
    if (text.includes('<artifact-file-write-required>')) return true;
    if (message.role === 'user' && explicitFileIntentPattern.test(text)) return true;
  }

  return false;
}

export function hasExplicitArtifactRepairIntent(messages: ModelMessage[]): boolean {
  const repairIntentPattern = /\b(fix|repair|patch|correct|restore)\b|修复|修正|修好|改好|失败|不通过|报错|不过/i;
  const artifactTargetPattern = /\b\w[\w.-]*\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)\b|\/[\w .@-]+\/[\w .@-]+\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)|\\[\w .@-]+\\[\w .@-]+\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)/i;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const text = extractMessageText(message);
    if (!text) continue;
    if (repairIntentPattern.test(text) && artifactTargetPattern.test(text)) return true;
  }

  return false;
}

export function hasArtifactFileWriteRequiredMarker(messages: ModelMessage[]): boolean {
  return messages.some((message) =>
    message.role === 'system' &&
    extractMessageText(message).includes('<artifact-file-write-required>')
  );
}

export function shouldPreferNonStreamingArtifactTurn(
  messages: ModelMessage[],
  onStream?: StreamCallback,
  options?: InferenceOptions,
): boolean {
  if (!onStream) return false;
  if (options?.forceNonStreaming === true) return false;
  if (!isArtifactLikeRequest(messages)) return false;
  if (!hasToolResultContext(messages)) return false;
  return hasIncompleteArtifactToolStream(messages);
}

export function hasToolResultContext(messages: ModelMessage[]): boolean {
  return messages.some((message) => message.role === 'tool');
}

export function hasIncompleteArtifactToolStream(messages: ModelMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'tool') continue;

    const content = extractMessageText(message).toLowerCase();
    return (
      content.includes('stream ended before [done]') ||
      content.includes('invalid streamed tool arguments') ||
      content.includes('refusing to execute incomplete tool arguments') ||
      content.includes('工具参数不完整') ||
      content.includes('代码完整性警告')
    );
  }
  return false;
}

export function extractMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}
