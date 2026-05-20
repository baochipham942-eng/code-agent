import { z } from 'zod';
import type {
  Task,
  TaskEvent,
  TaskFailure,
  TaskNotification,
  TaskOutputRef,
  TaskProgress,
} from '../../contract/backgroundTask';
import { IPC_DOMAINS } from '../domains';
import { IPCResponseSchema, channelSchema } from './core';

const TaskStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_input',
  'stalled',
  'completed',
  'failed',
  'cancelled',
  'paused',
  'expired',
  'orphaned',
]);

const TaskNotificationTypeSchema = z.enum([
  'task_created',
  'task_updated',
  'task_completed',
  'task_failed',
  'output_added',
  'custom',
]);

const TaskOutputRefTypeSchema = z.enum([
  'artifact',
  'file',
  'log',
  'report',
  'preview',
  'replay',
  'session',
  'url',
  'trace',
  'text',
  'other',
]);

const TaskMetadataSchema = z.record(z.unknown());

export const TaskProgressSchema: z.ZodType<TaskProgress> = z.object({
  current: z.number().optional(),
  total: z.number().optional(),
  percent: z.number().optional(),
  label: z.string().optional(),
});

export const TaskFailureSchema: z.ZodType<TaskFailure> = z.object({
  message: z.string(),
  reason: z.string().optional(),
  exitCode: z.number().optional(),
  category: z.string().optional(),
});

export const TaskEventSchema: z.ZodType<TaskEvent> = z.object({
  id: z.string(),
  taskId: z.string(),
  type: z.string(),
  status: TaskStatusSchema.optional(),
  message: z.string().optional(),
  timestamp: z.number(),
  data: z.unknown().optional(),
  metadata: TaskMetadataSchema.optional(),
});

export const TaskOutputRefSchema: z.ZodType<TaskOutputRef> = z.object({
  id: z.string(),
  taskId: z.string(),
  type: TaskOutputRefTypeSchema,
  label: z.string().optional(),
  uri: z.string().optional(),
  path: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  createdAt: z.number(),
  metadata: TaskMetadataSchema.optional(),
});

export const TaskNotificationSchema: z.ZodType<TaskNotification> = z.object({
  id: z.string(),
  taskId: z.string(),
  sessionId: z.string(),
  type: TaskNotificationTypeSchema,
  title: z.string().optional(),
  message: z.string(),
  createdAt: z.number(),
  deliveredAt: z.number().optional(),
  payload: z.unknown().optional(),
  metadata: TaskMetadataSchema.optional(),
});

export const TaskSchema: z.ZodType<Task> = z.object({
  id: z.string(),
  kind: z.string().optional(),
  sessionId: z.string().optional(),
  parentTurnId: z.string().optional(),
  toolCallId: z.string().optional(),
  runId: z.string().optional(),
  source: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  status: TaskStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  progress: TaskProgressSchema.optional(),
  failure: TaskFailureSchema.optional(),
  unread: z.boolean().optional(),
  metadata: TaskMetadataSchema.optional(),
  events: z.array(TaskEventSchema),
  outputRefs: z.array(TaskOutputRefSchema),
});

const ListTasksFilterSchema = z.object({
  sessionId: z.string().optional(),
  status: z.union([TaskStatusSchema, z.array(TaskStatusSchema)]).optional(),
  source: z.union([z.string(), z.array(z.string())]).optional(),
});

const ListTasksRequestSchema = z.object({
  action: z.literal('listTasks'),
  payload: ListTasksFilterSchema.optional(),
  requestId: z.string().optional(),
});

const GetTaskRequestSchema = z.object({
  action: z.literal('getTask'),
  payload: z.object({ taskId: z.string() }),
  requestId: z.string().optional(),
});

const DrainNotificationsRequestSchema = z.object({
  action: z.literal('drainNotifications'),
  payload: z.object({ sessionId: z.string() }),
  requestId: z.string().optional(),
});

const MarkNotificationDeliveredRequestSchema = z.object({
  action: z.literal('markNotificationDelivered'),
  payload: z.object({ notificationId: z.string() }),
  requestId: z.string().optional(),
});

const BackgroundTaskRequestSchema = z.discriminatedUnion('action', [
  ListTasksRequestSchema,
  GetTaskRequestSchema,
  DrainNotificationsRequestSchema,
  MarkNotificationDeliveredRequestSchema,
]);

const ListTasksResponseSchema = IPCResponseSchema(z.array(TaskSchema));
const GetTaskResponseSchema = IPCResponseSchema(TaskSchema.nullable());
const DrainNotificationsResponseSchema = IPCResponseSchema(z.array(TaskNotificationSchema));
const MarkNotificationDeliveredResponseSchema = IPCResponseSchema(TaskNotificationSchema.nullable());

const BackgroundTaskResponseSchema = z.union([
  ListTasksResponseSchema,
  GetTaskResponseSchema,
  DrainNotificationsResponseSchema,
  MarkNotificationDeliveredResponseSchema,
]);

export const BackgroundTaskSchemas = {
  REQUEST: channelSchema({
    channel: IPC_DOMAINS.BACKGROUND_TASKS,
    payload: BackgroundTaskRequestSchema,
    response: BackgroundTaskResponseSchema,
  }),
  LIST_TASKS: channelSchema({
    channel: IPC_DOMAINS.BACKGROUND_TASKS,
    payload: ListTasksRequestSchema,
    response: ListTasksResponseSchema,
  }),
  GET_TASK: channelSchema({
    channel: IPC_DOMAINS.BACKGROUND_TASKS,
    payload: GetTaskRequestSchema,
    response: GetTaskResponseSchema,
  }),
  DRAIN_NOTIFICATIONS: channelSchema({
    channel: IPC_DOMAINS.BACKGROUND_TASKS,
    payload: DrainNotificationsRequestSchema,
    response: DrainNotificationsResponseSchema,
  }),
  MARK_NOTIFICATION_DELIVERED: channelSchema({
    channel: IPC_DOMAINS.BACKGROUND_TASKS,
    payload: MarkNotificationDeliveredRequestSchema,
    response: MarkNotificationDeliveredResponseSchema,
  }),
} as const;

export type BackgroundTaskRequest = z.infer<typeof BackgroundTaskRequestSchema>;
