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

export const AgentRunBodySchema = z.object({
  prompt: z.string().min(1),
  project: z.string().optional(),
  sessionDir: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  generation: z.string().optional(),
  sessionId: z.string().optional(),
  clientMessageId: z.string().optional(),
  attachments: z.array(MessageAttachmentBodySchema).optional(),
  context: ConversationEnvelopeContextBodySchema.optional(),
}).passthrough();

export const AgentCancelBodySchema = z.object({
  sessionId: z.string().optional(),
}).passthrough();

export const AgentToolResultBodySchema = z.object({
  toolCallId: z.string().min(1),
  success: z.unknown().optional(),
  output: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();
