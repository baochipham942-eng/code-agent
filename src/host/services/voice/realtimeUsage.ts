// ============================================================================
// Realtime usage 解析（从 realtimeTransport 拆出，god-file 债务门：effective>1000）
// DashScope 的 tokens_details 是稀疏的：没消耗的形态不发字段（2026-08-13 直连抓包确证）。
// ============================================================================

import type { RealtimeVoiceProviderProfile } from '../../../shared/constants/realtimeVoiceProviders';
import type { VoiceTokenUsage } from '../../../shared/contract/voice';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseDashscopeUsage(raw: unknown): VoiceTokenUsage | undefined {
  if (!isRecord(raw) || !isRecord(raw.input_tokens_details) || !isRecord(raw.output_tokens_details)) return undefined;
  const totalTokens = tokenCount(raw, 'total_tokens');
  const inputTokens = tokenCount(raw, 'input_tokens');
  const outputTokens = tokenCount(raw, 'output_tokens');
  if (totalTokens === undefined || inputTokens === undefined || outputTokens === undefined) return undefined;
  // DashScope 的 details 是稀疏的：没消耗的形态不发字段（纯文本输入没有 audio_tokens）。
  // 缺席 = 0；顶层三个总量字段仍必需，防止把完全不认识的形状静默算成 0。
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    inputAudioTokens: tokenCount(raw.input_tokens_details, 'audio_tokens') ?? 0,
    inputTextTokens: tokenCount(raw.input_tokens_details, 'text_tokens') ?? 0,
    outputAudioTokens: tokenCount(raw.output_tokens_details, 'audio_tokens') ?? 0,
    outputTextTokens: tokenCount(raw.output_tokens_details, 'text_tokens') ?? 0,
  };
}

function parseOpenAIUsage(raw: unknown): VoiceTokenUsage | undefined {
  if (!isRecord(raw) || !isRecord(raw.input_token_details) || !isRecord(raw.output_token_details)) return undefined;
  const totalTokens = tokenCount(raw, 'total_tokens');
  const inputTokens = tokenCount(raw, 'input_tokens');
  const outputTokens = tokenCount(raw, 'output_tokens');
  const inputAudioTokens = tokenCount(raw.input_token_details, 'audio_tokens');
  const inputTextTokens = tokenCount(raw.input_token_details, 'text_tokens');
  const outputAudioTokens = tokenCount(raw.output_token_details, 'audio_tokens');
  const outputTextTokens = tokenCount(raw.output_token_details, 'text_tokens');
  if (
    totalTokens === undefined
    || inputTokens === undefined
    || outputTokens === undefined
    || inputAudioTokens === undefined
    || inputTextTokens === undefined
    || outputAudioTokens === undefined
    || outputTextTokens === undefined
  ) return undefined;
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    inputAudioTokens,
    inputTextTokens,
    outputAudioTokens,
    outputTextTokens,
  };
}

export function parseResponseUsage(profile: RealtimeVoiceProviderProfile, raw: unknown): VoiceTokenUsage | undefined {
  return profile.sessionShape === 'dashscope-compatible'
    ? parseDashscopeUsage(raw)
    : parseOpenAIUsage(raw);
}

