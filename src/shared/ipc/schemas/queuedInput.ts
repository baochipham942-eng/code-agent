import { z } from 'zod';
import type { ConversationEnvelope } from '../../contract/conversationEnvelope';
import type {
  MarkQueuedInputSendingResult,
  QueuedInput,
  QueuedInputSendOutcomeResult,
  ReorderQueuedInputsResult,
  RetractQueuedInputResult,
  UpdateQueuedInputResult,
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

const ConversationModelSpecSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

const ConversationEnvelopeSchema = z.object({
  content: z.string(),
  options: z.object({
    modelSpec: ConversationModelSpecSchema.optional(),
  }).passthrough().optional(),
}).passthrough().transform((value) => value as ConversationEnvelope);

export const QueuedInputSchema: z.ZodType<QueuedInput> = z.object({
  id: z.string(),
  sessionId: z.string(),
  envelope: ConversationEnvelopeSchema,
  status: QueuedInputStatusSchema,
  retryCount: z.number().int().nonnegative(),
  position: z.number().int().nonnegative(),
  pausedReason: z.string().nullable(),
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

const UpdateQueuedInputRequestSchema = z.object({
  action: z.literal('update'),
  payload: z.object({ id: z.string(), content: z.string() }),
  requestId: z.string().optional(),
});

const ReorderQueuedInputsRequestSchema = z.object({
  action: z.literal('reorder'),
  payload: z.object({
    sessionId: z.string(),
    orderedIds: z.array(z.string()).min(1),
  }),
  requestId: z.string().optional(),
});

const SendNowQueuedInputRequestSchema = z.object({
  action: z.literal('sendNow'),
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
  UpdateQueuedInputRequestSchema,
  ReorderQueuedInputsRequestSchema,
  SendNowQueuedInputRequestSchema,
  RetractQueuedInputRequestSchema,
  MarkQueuedInputSendingRequestSchema,
  ReportQueuedInputSendOutcomeRequestSchema,
]);

const EnqueueQueuedInputResponseSchema = IPCResponseSchema(QueuedInputSchema);
const ListQueuedInputsResponseSchema = IPCResponseSchema(z.array(QueuedInputSchema));
const RetractQueuedInputResponseSchema = IPCResponseSchema(
  z.object({ retracted: z.boolean() }) satisfies z.ZodType<RetractQueuedInputResult>,
);
const UpdateQueuedInputResponseSchema = IPCResponseSchema(
  z.object({ updated: z.boolean() }) satisfies z.ZodType<UpdateQueuedInputResult>,
);
const ReorderQueuedInputsResponseSchema = IPCResponseSchema(
  z.object({ reordered: z.boolean() }) satisfies z.ZodType<ReorderQueuedInputsResult>,
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
  UpdateQueuedInputResponseSchema,
  ReorderQueuedInputsResponseSchema,
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
  UPDATE: channelSchema({
    channel: IPC_DOMAINS.QUEUED_INPUT,
    payload: UpdateQueuedInputRequestSchema,
    response: UpdateQueuedInputResponseSchema,
  }),
  REORDER: channelSchema({
    channel: IPC_DOMAINS.QUEUED_INPUT,
    payload: ReorderQueuedInputsRequestSchema,
    response: ReorderQueuedInputsResponseSchema,
  }),
  SEND_NOW: channelSchema({
    channel: IPC_DOMAINS.QUEUED_INPUT,
    payload: SendNowQueuedInputRequestSchema,
    response: ReportQueuedInputSendOutcomeResponseSchema,
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
