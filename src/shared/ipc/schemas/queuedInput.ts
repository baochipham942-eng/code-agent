import { z } from 'zod';
import type { ConversationEnvelope } from '../../contract/conversationEnvelope';
import type {
  MarkQueuedInputSendingResult,
  QueuedInput,
  QueuedInputSendOutcomeResult,
  RetractQueuedInputResult,
} from '../../contract/queuedInput';
import { IPC_DOMAINS } from '../domains';
import { IPCResponseSchema, channelSchema } from './core';

const QueuedInputStatusSchema = z.enum([
  'queued',
  'sending',
  'consumed',
  'retracted',
  'failed',
]);

const ConversationEnvelopeSchema = z.custom<ConversationEnvelope>(
  (value) => (
    typeof value === 'object'
    && value !== null
    && typeof (value as { content?: unknown }).content === 'string'
  ),
  { message: 'Expected a ConversationEnvelope with string content' },
);

export const QueuedInputSchema: z.ZodType<QueuedInput> = z.object({
  id: z.string(),
  sessionId: z.string(),
  envelope: ConversationEnvelopeSchema,
  status: QueuedInputStatusSchema,
  retryCount: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const EnqueueQueuedInputRequestSchema = z.object({
  action: z.literal('enqueue'),
  payload: z.object({
    id: z.string(),
    sessionId: z.string(),
    envelope: ConversationEnvelopeSchema,
  }),
  requestId: z.string().optional(),
});

const ListQueuedInputsRequestSchema = z.object({
  action: z.literal('list'),
  payload: z.object({
    sessionId: z.string(),
    status: QueuedInputStatusSchema.optional(),
  }),
  requestId: z.string().optional(),
});

const RetractQueuedInputRequestSchema = z.object({
  action: z.literal('retract'),
  payload: z.object({ id: z.string() }),
  requestId: z.string().optional(),
});

const MarkQueuedInputSendingRequestSchema = z.object({
  action: z.literal('markSending'),
  payload: z.object({ id: z.string() }),
  requestId: z.string().optional(),
});

const ReportQueuedInputSendOutcomeRequestSchema = z.object({
  action: z.literal('reportSendOutcome'),
  payload: z.object({
    id: z.string(),
    outcome: z.enum(['success', 'failure']),
  }),
  requestId: z.string().optional(),
});

const QueuedInputRequestSchema = z.discriminatedUnion('action', [
  EnqueueQueuedInputRequestSchema,
  ListQueuedInputsRequestSchema,
  RetractQueuedInputRequestSchema,
  MarkQueuedInputSendingRequestSchema,
  ReportQueuedInputSendOutcomeRequestSchema,
]);

const EnqueueQueuedInputResponseSchema = IPCResponseSchema(QueuedInputSchema);
const ListQueuedInputsResponseSchema = IPCResponseSchema(z.array(QueuedInputSchema));
const RetractQueuedInputResponseSchema = IPCResponseSchema(
  z.object({ retracted: z.boolean() }) satisfies z.ZodType<RetractQueuedInputResult>,
);
const MarkQueuedInputSendingResponseSchema = IPCResponseSchema(
  z.object({ marked: z.boolean() }) satisfies z.ZodType<MarkQueuedInputSendingResult>,
);
const ReportQueuedInputSendOutcomeResponseSchema = IPCResponseSchema(
  z.object({
    status: QueuedInputStatusSchema,
    retryCount: z.number().int().nonnegative(),
  }) satisfies z.ZodType<QueuedInputSendOutcomeResult>,
);

const QueuedInputResponseSchema = z.union([
  EnqueueQueuedInputResponseSchema,
  ListQueuedInputsResponseSchema,
  RetractQueuedInputResponseSchema,
  MarkQueuedInputSendingResponseSchema,
  ReportQueuedInputSendOutcomeResponseSchema,
]);

export const QueuedInputSchemas = {
  REQUEST: channelSchema({
    channel: IPC_DOMAINS.QUEUED_INPUT,
    payload: QueuedInputRequestSchema,
    response: QueuedInputResponseSchema,
  }),
  ENQUEUE: channelSchema({
    channel: IPC_DOMAINS.QUEUED_INPUT,
    payload: EnqueueQueuedInputRequestSchema,
    response: EnqueueQueuedInputResponseSchema,
  }),
  LIST: channelSchema({
    channel: IPC_DOMAINS.QUEUED_INPUT,
    payload: ListQueuedInputsRequestSchema,
    response: ListQueuedInputsResponseSchema,
  }),
  RETRACT: channelSchema({
    channel: IPC_DOMAINS.QUEUED_INPUT,
    payload: RetractQueuedInputRequestSchema,
    response: RetractQueuedInputResponseSchema,
  }),
  MARK_SENDING: channelSchema({
    channel: IPC_DOMAINS.QUEUED_INPUT,
    payload: MarkQueuedInputSendingRequestSchema,
    response: MarkQueuedInputSendingResponseSchema,
  }),
  REPORT_SEND_OUTCOME: channelSchema({
    channel: IPC_DOMAINS.QUEUED_INPUT,
    payload: ReportQueuedInputSendOutcomeRequestSchema,
    response: ReportQueuedInputSendOutcomeResponseSchema,
  }),
} as const;

export type QueuedInputRequest = z.infer<typeof QueuedInputRequestSchema>;
