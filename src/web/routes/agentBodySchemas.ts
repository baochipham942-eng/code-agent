import { z } from 'zod';
import type { MessageAttachment } from '../../shared/contract/message';
import type { ConversationEnvelopeContext } from '../../shared/contract/conversationEnvelope';

const LooseObjectSchema = z.object({}).passthrough();

const MessageAttachmentBodySchema = LooseObjectSchema.transform(
  (value) => value as unknown as MessageAttachment,
);

const ConversationEnvelopeContextBodySchema = LooseObjectSchema.transform(
  (value) => value as unknown as ConversationEnvelopeContext,
);

// /goal 自治模式契约。verify / review 至少给一个（设计 §4）：
// - 只给 verify → 硬目标（闸1 确定性验证）
// - 只给 review → 软目标（跳闸1，只走闸2 评审）
// - 都给 → 闸1 通过再走闸2
// 两个都不给 → 无完成判据、永远只能 abort，拒绝启动。
export const GoalBodySchema = z.object({
  goal: z.string().optional(),
  verify: z.string().min(1).optional(),
  review: z.string().min(1).optional(),
  budget: z.number().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  allowSwarm: z.boolean().optional(),
}).refine((g) => !!g.verify || !!g.review, {
  message: 'goal 至少需要 verify 或 review 之一（否则无完成判据，永远无法达成）',
});

export const AgentRunBodySchema = z.object({
  prompt: z.string().min(1),
  project: z.string().optional(),
  sessionDir: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  sessionId: z.string().optional(),
  clientMessageId: z.string().optional(),
  attachments: z.array(MessageAttachmentBodySchema).optional(),
  context: ConversationEnvelopeContextBodySchema.optional(),
  goal: GoalBodySchema.optional(),
}).passthrough();

export const AgentCancelBodySchema = z.object({
  runId: z.string().optional(),
  sessionId: z.string().optional(),
}).passthrough();

export const AgentToolResultBodySchema = z.object({
  toolCallId: z.string().min(1),
  success: z.unknown().optional(),
  output: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();
