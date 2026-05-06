// ============================================================================
// OpenAI Wrapper — 覆盖 OpenAI / Moonshot / OpenRouter / Volcengine / Xiaomi /
// Qwen / Groq / Perplexity / Local 等 9 个 OpenAI 兼容子类的响应解析。
//
// 设计原则（plan §4.2）：
// 1. schema 写在 provider 旁边，不放 shared/contract
// 2. SSE 事件解析使用 safeParse + 降级，schema 失败只 logger.debug 不抛错
// 3. .passthrough() 容忍未知字段，避免 provider 加新字段崩 stream
// 4. 不在 chunk byte level 跑 zod，只在 JSON.parse 后的完整 chunk/response 跑一次
// ============================================================================
import { z } from 'zod';

import type { ToolCall } from '../../../../shared/contract';
import type { ModelResponse } from '../../types';
import { logger, safeJsonParse } from '../shared';

// ── helpers ───────────────────────────────────────────────────────────────
/**
 * 规范化工具名：去掉代理层添加的 `functions_` 前缀和 `_N` 数字后缀
 * 例: `functions_AgentSpawn_1` → `AgentSpawn`
 */
function normalizeToolName(name: string): string {
  if (!name) return name;
  let normalized = name;
  if (normalized.startsWith('functions_')) {
    normalized = normalized.slice('functions_'.length);
  }
  normalized = normalized.replace(/_\d+$/, '');
  return normalized || name;
}

// ── final response schemas ────────────────────────────────────────────────
const ToolCallSchema = z
  .object({
    id: z.string(),
    type: z.literal('function').optional(),
    function: z
      .object({
        name: z.string(),
        arguments: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const MessageSchema = z
  .object({
    role: z.string().optional(),
    content: z.string().nullable().optional(),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  })
  .passthrough();

const ChoiceSchema = z
  .object({
    index: z.number().optional(),
    message: MessageSchema,
    finish_reason: z.string().nullable().optional(),
  })
  .passthrough();

const UsageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough();

export const OpenAIChatCompletionSchema = z
  .object({
    id: z.string().optional(),
    object: z.string().optional(),
    created: z.number().optional(),
    model: z.string().optional(),
    choices: z.array(ChoiceSchema),
    usage: UsageSchema.optional(),
  })
  .passthrough();

export type OpenAIChatCompletion = z.infer<typeof OpenAIChatCompletionSchema>;
export type OpenAIChoice = z.infer<typeof ChoiceSchema>;
export type OpenAIMessage = z.infer<typeof MessageSchema>;

// ── stream chunk schemas ──────────────────────────────────────────────────
const StreamToolCallDeltaSchema = z
  .object({
    index: z.number().optional(),
    id: z.string().optional(),
    type: z.literal('function').optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const StreamDeltaSchema = z
  .object({
    role: z.string().optional(),
    content: z.string().nullable().optional(),
    reasoning_content: z.string().optional(),
    // Kimi K2.5 的 reasoning 字段名跟 DeepSeek/GLM 不同
    reasoning: z.string().optional(),
    tool_calls: z.array(StreamToolCallDeltaSchema).optional(),
  })
  .passthrough();

const StreamChoiceSchema = z
  .object({
    index: z.number().optional(),
    delta: StreamDeltaSchema.optional(),
    finish_reason: z.string().nullable().optional(),
  })
  .passthrough();

export const OpenAIStreamChunkSchema = z
  .object({
    choices: z.array(StreamChoiceSchema).optional(),
    usage: UsageSchema.optional(),
  })
  .passthrough();

export type OpenAIStreamChunk = z.infer<typeof OpenAIStreamChunkSchema>;
export type OpenAIStreamChoice = z.infer<typeof StreamChoiceSchema>;
export type OpenAIStreamDelta = z.infer<typeof StreamDeltaSchema>;
export type OpenAIToolCallDelta = z.infer<typeof StreamToolCallDeltaSchema>;

// ── parse: final response ─────────────────────────────────────────────────
/**
 * 解析非流式 OpenAI 兼容响应。
 *
 * 行为与旧 `shared.ts:parseOpenAIResponse` 100% 一致：
 *   1. zod 校验响应 shape，失败抛错（含 200 字 preview）
 *   2. tool_calls 优先：normalize 工具名 → safeJsonParse 解析 args
 *      - safeJsonParse 内部已带 repair fallback，失败返回 `{ __parseError: true }` 标记
 *   3. 无 tool_calls 时，文本 `Calling foo(...)` 模式 fallback 为 tool_use
 *   4. 都没命中返回 `{ type: 'text', content }`
 */
export function parseOpenAIResponse(raw: unknown): ModelResponse {
  const parsed = OpenAIChatCompletionSchema.safeParse(raw);
  if (!parsed.success) {
    const dataPreview = JSON.stringify(raw).substring(0, 200);
    logger.warn('[parseOpenAIResponse] schema mismatch:', {
      dataPreview,
      issues: parsed.error.issues,
    });
    throw new Error(`Invalid OpenAI response shape: ${dataPreview}`);
  }

  const choice = parsed.data.choices[0];
  if (!choice) {
    const dataPreview = JSON.stringify(raw).substring(0, 200);
    logger.warn('[parseOpenAIResponse] No choices in response:', dataPreview);
    throw new Error(`No response from model. Response: ${dataPreview}`);
  }

  const message = choice.message;

  if (message.tool_calls && message.tool_calls.length > 0) {
    const toolCalls: ToolCall[] = [];

    for (const tc of message.tool_calls) {
      const rawName = tc.function.name;
      const normalizedName = normalizeToolName(rawName);
      const argStr = tc.function.arguments || '{}';

      // safeJsonParse 自带 repair fallback，失败时返回 { __parseError: true, __rawArguments }
      // 行为对齐旧 parseOpenAIResponse — 即使含 __parseError 也 push（既有兼容性）
      const args = safeJsonParse(argStr);

      if (args.__parseError) {
        logger.warn(' Could not parse JSON arguments:', argStr.substring(0, 500));
        const content = message.content || `Tool call failed: ${rawName} - Invalid JSON arguments`;
        return { type: 'text', content };
      }

      toolCalls.push({
        id: tc.id,
        name: normalizedName,
        arguments: args,
      });
    }

    if (toolCalls.length > 0) {
      return { type: 'tool_use', toolCalls };
    }
  }

  const content = message.content || '';

  // text-based tool call fallback：模型偶尔以 `Calling foo({...})` 文本形式输出
  const textToolCallMatch = content.match(/Calling\s+(\w+)\s*\(/);
  if (textToolCallMatch) {
    const toolName = textToolCallMatch[1];
    const callStart = content.indexOf(textToolCallMatch[0]);
    const argsStart = callStart + textToolCallMatch[0].length;

    let depth = 1;
    let argsEnd = argsStart;
    for (let i = argsStart; i < content.length && depth > 0; i++) {
      if (content[i] === '{' || content[i] === '[') depth++;
      else if (content[i] === '}' || content[i] === ']') depth--;
      else if (content[i] === ')' && depth === 1) {
        argsEnd = i;
        break;
      }
      argsEnd = i + 1;
    }

    const argsStr = content.slice(argsStart, argsEnd);
    const args = safeJsonParse(argsStr);
    if (!args.__parseError) {
      logger.info(' Parsed text-based tool call:', toolName);
      return {
        type: 'tool_use',
        toolCalls: [
          {
            id: `text-${Date.now()}`,
            name: toolName,
            arguments: args,
          },
        ],
      };
    }
    logger.warn(' Failed to parse text-based tool call args:', argsStr.substring(0, 100));
  }

  return { type: 'text', content };
}

// ── parse: stream chunk ───────────────────────────────────────────────────
/**
 * 解析单个 SSE chunk。失败只 logger.debug 不抛错（hot path 安全）。
 *
 * 注意：调用方负责在 `JSON.parse(data)` 之前过滤 `[DONE]` 标记。
 */
export function parseOpenAIStreamChunk(raw: unknown): OpenAIStreamChunk | null {
  const parsed = OpenAIStreamChunkSchema.safeParse(raw);
  if (!parsed.success) {
    logger.debug('[parseOpenAIStreamChunk] schema mismatch, skipping', {
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}
