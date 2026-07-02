// ============================================================================
// Gemini Wrapper — Google Gemini generateContent / streamGenerateContent
// 响应 schema 化。覆盖 gemini.ts + geminiProvider.ts。
//
// Gemini parts 没有 discriminator key（不像 Anthropic 的 `type` 字段），
// 因此 GeminiPart 用宽松 object schema 而不是 discriminatedUnion。
// ============================================================================
import { z } from 'zod';

import type { ToolCall } from '../../../../shared/contract';
import type { ModelResponse } from '../../types';
import { logger } from '../providerRuntime';
import { normalizeGeminiUsage } from './usageNormalization';

// ── parts ─────────────────────────────────────────────────────────────────
const FunctionCallPartSchema = z
  .object({
    name: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const InlineDataPartSchema = z
  .object({
    mimeType: z.string(),
    data: z.string(),
  })
  .passthrough();

/**
 * Gemini part 是 union（text | functionCall | inlineData | functionResponse | ...）
 * 但没有共同 discriminator，因此用 optional fields 表达，passthrough 兜未来字段
 */
const GeminiPartSchema = z
  .object({
    text: z.string().optional(),
    functionCall: FunctionCallPartSchema.optional(),
    inlineData: InlineDataPartSchema.optional(),
  })
  .passthrough();

export type GeminiPart = z.infer<typeof GeminiPartSchema>;

// ── content + candidate ───────────────────────────────────────────────────
const GeminiContentSchema = z
  .object({
    role: z.string().optional(),
    parts: z.array(GeminiPartSchema).optional(),
  })
  .passthrough();

const GeminiCandidateSchema = z
  .object({
    content: GeminiContentSchema.optional(),
    finishReason: z.string().optional(),
    index: z.number().optional(),
  })
  .passthrough();

const GeminiUsageMetadataSchema = z
  .object({
    promptTokenCount: z.number().optional(),
    candidatesTokenCount: z.number().optional(),
    totalTokenCount: z.number().optional(),
    // implicit caching 命中量（promptTokenCount 含此部分，归一化时扣除）
    cachedContentTokenCount: z.number().optional(),
  })
  .passthrough();

export const GeminiResponseSchema = z
  .object({
    candidates: z.array(GeminiCandidateSchema).optional(),
    usageMetadata: GeminiUsageMetadataSchema.optional(),
    promptFeedback: z.unknown().optional(),
  })
  .passthrough();

export type GeminiResponse = z.infer<typeof GeminiResponseSchema>;
export type GeminiCandidate = z.infer<typeof GeminiCandidateSchema>;

// ── parse: final response ─────────────────────────────────────────────────
/**
 * 解析非流式 Gemini 响应（行为对齐旧 `shared.ts:parseGeminiResponse`）：
 *   1. zod 校验
 *   2. 取 candidate[0].content.parts[0].text 作为 content
 *   3. 收集所有含 functionCall 的 parts → ToolCall
 *   4. 返回总是带 toolCalls 字段（兼容旧行为，即使为空数组）
 */
export function parseGeminiResponse(raw: unknown): ModelResponse {
  const parsed = GeminiResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const preview = JSON.stringify(raw).substring(0, 200);
    logger.warn('[parseGeminiResponse] schema mismatch:', { preview, issues: parsed.error.issues });
    throw new Error(`Invalid Gemini response shape: ${preview}`);
  }

  const candidate = parsed.data.candidates?.[0];
  if (!candidate) {
    throw new Error('No response from Gemini');
  }

  const parts = candidate.content?.parts ?? [];
  const content = parts[0]?.text ?? '';

  const toolCalls: ToolCall[] = [];
  const functionCallParts = parts.filter((p) => p.functionCall);
  for (const fc of functionCallParts) {
    if (!fc.functionCall) continue;
    toolCalls.push({
      id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: fc.functionCall.name,
      arguments: fc.functionCall.args ?? {},
    });
  }

  // usage 带回（含 cachedContentTokenCount，归一化后进预算层）
  const usage = parsed.data.usageMetadata
    ? normalizeGeminiUsage(parsed.data.usageMetadata)
    : undefined;

  return {
    type: toolCalls.length > 0 ? 'tool_use' : 'text',
    content,
    toolCalls,
    ...(usage ? { usage } : {}),
  };
}

// ── parse: stream chunk ───────────────────────────────────────────────────
/**
 * 解析单个 Gemini stream chunk。失败只 logger.debug 不抛错。
 *
 * 注意：调用方负责在 `JSON.parse(data)` 之前去掉 `data: ` SSE 前缀。
 */
export function parseGeminiStreamChunk(raw: unknown): GeminiResponse | null {
  const parsed = GeminiResponseSchema.safeParse(raw);
  if (!parsed.success) {
    logger.debug('[parseGeminiStreamChunk] schema mismatch, skipping', {
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}
