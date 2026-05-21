// ============================================================================
// Anthropic Wrapper — Claude Messages API 响应 + SSE 事件 schema 化。
//
// SSE 事件用 discriminatedUnion('type') 对齐 Anthropic SSE 协议：
//   message_start / content_block_start / content_block_delta / content_block_stop
//   / message_delta / message_stop / error / ping
//
// hot path 纪律：
//   - safeParse 失败只 logger.debug 不抛错（schema 变化不能崩 stream）
//   - .passthrough() 容忍未知字段
// ============================================================================
import { z } from 'zod';

import type { ToolCall } from '../../../../shared/contract';
import type { ModelResponse } from '../../types';
import { logger } from '../shared';

// ── content blocks (text | tool_use | thinking | server_tool_use) ────────
const TextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

const ToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const ThinkingBlockSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string(),
  })
  .passthrough();

const ServerToolUseBlockSchema = z
  .object({
    type: z.literal('server_tool_use'),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const ClaudeContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ToolUseBlockSchema,
  ThinkingBlockSchema,
  ServerToolUseBlockSchema,
]);

export type ClaudeContentBlock = z.infer<typeof ClaudeContentBlockSchema>;

// ── final response (non-streaming Messages API) ──────────────────────────
const ClaudeUsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  })
  .passthrough();

export const ClaudeMessageSchema = z
  .object({
    id: z.string().optional(),
    type: z.literal('message').optional(),
    role: z.literal('assistant').optional(),
    model: z.string().optional(),
    content: z.array(ClaudeContentBlockSchema),
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
    usage: ClaudeUsageSchema.optional(),
  })
  .passthrough();

export type ClaudeMessage = z.infer<typeof ClaudeMessageSchema>;

// ── SSE event deltas ──────────────────────────────────────────────────────
const TextDeltaSchema = z
  .object({
    type: z.literal('text_delta'),
    text: z.string(),
  })
  .passthrough();

const InputJsonDeltaSchema = z
  .object({
    type: z.literal('input_json_delta'),
    partial_json: z.string(),
  })
  .passthrough();

const ThinkingDeltaSchema = z
  .object({
    type: z.literal('thinking_delta'),
    thinking: z.string(),
  })
  .passthrough();

const SignatureDeltaSchema = z
  .object({
    type: z.literal('signature_delta'),
    signature: z.string().optional(),
  })
  .passthrough();

const ContentBlockDeltaInnerSchema = z.discriminatedUnion('type', [
  TextDeltaSchema,
  InputJsonDeltaSchema,
  ThinkingDeltaSchema,
  SignatureDeltaSchema,
]);

export type ClaudeContentBlockDelta = z.infer<typeof ContentBlockDeltaInnerSchema>;

// ── SSE event (discriminatedUnion on type) ────────────────────────────────
const MessageStartEventSchema = z
  .object({
    type: z.literal('message_start'),
    message: ClaudeMessageSchema.extend({
      // message_start 时 content 通常是空数组
      content: z.array(ClaudeContentBlockSchema).default([]),
    }).partial({ content: true }),
  })
  .passthrough();

const ContentBlockStartEventSchema = z
  .object({
    type: z.literal('content_block_start'),
    index: z.number(),
    content_block: ClaudeContentBlockSchema,
  })
  .passthrough();

const ContentBlockDeltaEventSchema = z
  .object({
    type: z.literal('content_block_delta'),
    index: z.number(),
    delta: ContentBlockDeltaInnerSchema,
  })
  .passthrough();

const ContentBlockStopEventSchema = z
  .object({
    type: z.literal('content_block_stop'),
    index: z.number(),
  })
  .passthrough();

const MessageDeltaEventSchema = z
  .object({
    type: z.literal('message_delta'),
    delta: z
      .object({
        stop_reason: z.string().nullable().optional(),
        stop_sequence: z.string().nullable().optional(),
      })
      .passthrough(),
    usage: ClaudeUsageSchema.optional(),
  })
  .passthrough();

const MessageStopEventSchema = z
  .object({
    type: z.literal('message_stop'),
  })
  .passthrough();

const PingEventSchema = z
  .object({
    type: z.literal('ping'),
  })
  .passthrough();

const ErrorEventSchema = z
  .object({
    type: z.literal('error'),
    error: z
      .object({
        type: z.string().optional(),
        message: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const ClaudeSSEEventSchema = z.discriminatedUnion('type', [
  MessageStartEventSchema,
  ContentBlockStartEventSchema,
  ContentBlockDeltaEventSchema,
  ContentBlockStopEventSchema,
  MessageDeltaEventSchema,
  MessageStopEventSchema,
  PingEventSchema,
  ErrorEventSchema,
]);

export type ClaudeSSEEvent = z.infer<typeof ClaudeSSEEventSchema>;

// ── parse: final response ─────────────────────────────────────────────────
/**
 * 解析非流式 Claude Messages 响应（行为对齐旧 `shared.ts:parseClaudeResponse`）：
 *   1. zod 校验
 *   2. 优先 tool_use blocks → ModelResponse.tool_use
 *   3. 否则 text blocks 拼接 → ModelResponse.text
 */
export function parseClaudeResponse(raw: unknown): ModelResponse {
  const parsed = ClaudeMessageSchema.safeParse(raw);
  if (!parsed.success) {
    const preview = JSON.stringify(raw).substring(0, 200);
    logger.warn('[parseClaudeResponse] schema mismatch:', { preview, issues: parsed.error.issues });
    throw new Error(`Invalid Claude response shape: ${preview}`);
  }

  const content = parsed.data.content;
  if (!content || content.length === 0) {
    throw new Error('No response from model');
  }

  const toolUseBlocks = content.filter(
    (b): b is z.infer<typeof ToolUseBlockSchema> => b.type === 'tool_use',
  );
  if (toolUseBlocks.length > 0) {
    const toolCalls: ToolCall[] = toolUseBlocks.map((b) => ({
      id: b.id,
      name: b.name,
      arguments: b.input ?? {},
    }));
    return { type: 'tool_use', toolCalls };
  }

  const textBlocks = content.filter(
    (b): b is z.infer<typeof TextBlockSchema> => b.type === 'text',
  );
  const text = textBlocks.map((b) => b.text).join('\n');

  return { type: 'text', content: text };
}

// ── parse: SSE event ──────────────────────────────────────────────────────
/**
 * 解析单个 Claude SSE 事件。Anthropic SSE 格式：
 *   `event: message_start`
 *   `data: { ... }`
 *
 * 调用方先解析出 eventType（来自 `event:` 行）和 rawData（来自 `data:` 行的 JSON.parse 结果）。
 *
 * 失败时返回 null（hot path 安全），调用方应跳过该事件。
 */
export function parseClaudeSSEEvent(eventType: string, rawData: unknown): ClaudeSSEEvent | null {
  // Anthropic 协议 data JSON 通常本身就含 type 字段（== eventType），但部分代理只发 data 不发 event header
  // 兜底：以 eventType 为准注入 type
  const candidate =
    typeof rawData === 'object' && rawData !== null
      ? { ...(rawData as Record<string, unknown>), type: eventType }
      : { type: eventType };

  const parsed = ClaudeSSEEventSchema.safeParse(candidate);
  if (!parsed.success) {
    logger.debug('[parseClaudeSSEEvent] unknown event shape, skipping', {
      eventType,
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}
