import type {
  AddTaskOutputRefInput,
  AppendTaskEventInput,
  ListTasksFilter,
  QueueTaskNotificationInput,
  Task,
  TaskEvent,
  TaskFailure,
  TaskMetadata,
  TaskNotification,
  TaskOutputRef,
  TaskProgress,
  TaskStatus,
  UpsertTaskInput,
} from '../../shared/contract/backgroundTask';
import { isTerminalTaskStatus } from '../../shared/contract/backgroundTask';
import type { BackgroundTaskLedgerChangedData } from '../../shared/contract/agent';
import { getEventBus } from '../services/eventing/bus';
import type { BackgroundTaskStore } from './backgroundTaskStore';

type IdKind = 'task-event' | 'task-output' | 'task-notification';

export interface BackgroundTaskLedgerOptions {
  now?: () => number;
  idFactory?: (kind: IdKind) => string;
  store?: BackgroundTaskStore | null;
}

const DEFAULT_TASK_SOURCE = 'manual';
const DEFAULT_TASK_STATUS: TaskStatus = 'queued';

export class BackgroundTaskLedger {
  private readonly tasks = new Map<string, Task>();
  private readonly notifications = new Map<string, TaskNotification>();
  private readonly notificationOrder: string[] = [];
  private sequence = 0;
  private quietDepth = 0;
  private store?: BackgroundTaskStore;

  constructor(private readonly options: BackgroundTaskLedgerOptions = {}) {
    this.store = options.store ?? undefined;
  }

  setStore(store: BackgroundTaskStore | null): void {
    this.store = store ?? undefined;
  }

  runQuiet<T>(fn: () => T): T {
    this.quietDepth += 1;
    try {
      return fn();
    } finally {
      this.quietDepth -= 1;
    }
  }

  upsertTask(input: UpsertTaskInput): Task {
    this.assertNonEmpty(input.id, 'task id');

    const now = this.now();
    const existing = this.tasks.get(input.id);
    const status = input.status ?? existing?.status ?? DEFAULT_TASK_STATUS;
    const timestamp = input.updatedAt ?? now;
    const next: Task = {
      id: input.id,
      kind: input.kind ?? existing?.kind,
      sessionId: input.sessionId ?? existing?.sessionId,
      parentTurnId: input.parentTurnId ?? existing?.parentTurnId,
      toolCallId: input.toolCallId ?? existing?.toolCallId,
      runId: input.runId ?? existing?.runId,
      source: input.source ?? existing?.source ?? DEFAULT_TASK_SOURCE,
      title: input.title ?? existing?.title ?? input.id,
      summary: input.summary ?? existing?.summary,
      command: input.command ?? existing?.command,
      cwd: input.cwd ?? existing?.cwd,
      status,
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      updatedAt: timestamp,
      startedAt: input.startedAt ?? existing?.startedAt ?? (status === 'running' ? timestamp : undefined),
      completedAt: input.completedAt ?? existing?.completedAt ?? (isTerminalTaskStatus(status) ? timestamp : undefined),
      durationMs: input.durationMs ?? existing?.durationMs,
      progress: cloneProgress(input.progress ?? existing?.progress),
      failure: cloneFailure(input.failure ?? existing?.failure),
      metadata: cloneMetadata(input.metadata ?? existing?.metadata),
      events: existing?.events.map(cloneTaskEvent) ?? [],
      outputRefs: existing?.outputRefs.map(cloneOutputRef) ?? [],
    };

    this.tasks.set(next.id, next);
    this.persistIfTerminal(next);
    this.publishChanged(next.id, next.sessionId);
    return cloneTask(next);
  }

  appendEvent(input: AppendTaskEventInput): TaskEvent {
    this.assertNonEmpty(input.taskId, 'task id');
    this.assertNonEmpty(input.type, 'event type');

    const task = this.requireTask(input.taskId);
    const timestamp = input.timestamp ?? this.now();
    const event: TaskEvent = {
      id: input.id ?? this.nextId('task-event'),
      taskId: input.taskId,
      type: input.type,
      status: input.status,
      message: input.message,
      timestamp,
      data: input.data,
      metadata: cloneMetadata(input.metadata),
    };

    const nextStatus = event.status ?? task.status;
    const next: Task = {
      ...task,
      status: nextStatus,
      updatedAt: timestamp,
      startedAt: task.startedAt ?? (nextStatus === 'running' ? timestamp : undefined),
      completedAt: task.completedAt ?? (isTerminalTaskStatus(nextStatus) ? timestamp : undefined),
      progress: cloneProgress(task.progress),
      failure: cloneFailure(task.failure),
      metadata: cloneMetadata(task.metadata),
      events: [...task.events, event],
      outputRefs: task.outputRefs.map(cloneOutputRef),
    };

    this.tasks.set(task.id, next);
    this.persistEvent(next, event);
    this.publishChanged(next.id, next.sessionId);
    return cloneTaskEvent(event);
  }

  addOutputRef(input: AddTaskOutputRefInput): TaskOutputRef {
    this.assertNonEmpty(input.taskId, 'task id');

    const task = this.requireTask(input.taskId);
    const createdAt = input.createdAt ?? this.now();
    const outputRef: TaskOutputRef = {
      id: input.id ?? this.nextId('task-output'),
      taskId: input.taskId,
      type: input.type,
      label: input.label,
      uri: input.uri,
      path: input.path,
      mimeType: input.mimeType,
      size: input.size,
      createdAt,
      metadata: cloneMetadata(input.metadata),
    };

    const next: Task = {
      ...task,
      updatedAt: Math.max(task.updatedAt, createdAt),
      progress: cloneProgress(task.progress),
      failure: cloneFailure(task.failure),
      metadata: cloneMetadata(task.metadata),
      events: task.events.map(cloneTaskEvent),
      outputRefs: [
        ...task.outputRefs.filter((existing) => existing.id !== outputRef.id),
        outputRef,
      ],
    };

    this.tasks.set(task.id, next);
    this.persistIfTerminal(next);
    this.publishChanged(next.id, next.sessionId);
    return cloneOutputRef(outputRef);
  }

  queueNotification(input: QueueTaskNotificationInput): TaskNotification {
    this.assertNonEmpty(input.taskId, 'task id');
    this.assertNonEmpty(input.message, 'notification message');

    const existing = input.id ? this.notifications.get(input.id) : undefined;
    if (existing) {
      return cloneNotification(existing);
    }

    const task = this.tasks.get(input.taskId);
    const sessionId = input.sessionId ?? task?.sessionId;
    this.assertNonEmpty(sessionId, 'notification session id');

    const notification: TaskNotification = {
      id: input.id ?? this.nextId('task-notification'),
      taskId: input.taskId,
      sessionId,
      type: input.type,
      title: input.title,
      message: input.message,
      createdAt: input.createdAt ?? this.now(),
      payload: input.payload,
      metadata: cloneMetadata(input.metadata),
    };

    this.notifications.set(notification.id, notification);
    this.notificationOrder.push(notification.id);
    this.store?.queueNotification(cloneNotification(notification));
    this.publishChanged(notification.taskId, notification.sessionId);
    return cloneNotification(notification);
  }

  markNotificationDelivered(notificationId: string, deliveredAt = this.now()): TaskNotification | null {
    this.assertNonEmpty(notificationId, 'notification id');

    const notification = this.notifications.get(notificationId);
    if (!notification) {
      return null;
    }

    const delivered: TaskNotification = {
      ...notification,
      deliveredAt: notification.deliveredAt ?? deliveredAt,
      metadata: cloneMetadata(notification.metadata),
    };
    this.notifications.set(notificationId, delivered);
    this.store?.queueNotification(cloneNotification(delivered));
    return cloneNotification(delivered);
  }

  listTasks(filter: ListTasksFilter = {}): Task[] {
    const statuses = toSet(filter.status);
    const sources = toSet(filter.source);

    const merged = new Map<string, Task>();
    for (const task of this.readTerminalTasksFromStore(filter)) {
      merged.set(task.id, task);
    }
    for (const task of this.tasks.values()) {
      merged.set(task.id, task);
    }

    return [...merged.values()]
      .filter((task) => !filter.sessionId || task.sessionId === filter.sessionId)
      .filter((task) => !statuses || statuses.has(task.status))
      .filter((task) => !sources || sources.has(task.source))
      .sort(compareTasks)
      .map(cloneTask);
  }

  drainNotifications(sessionId: string): TaskNotification[] {
    this.assertNonEmpty(sessionId, 'session id');

    const deliveredAt = this.now();
    const drained: TaskNotification[] = [];

    for (const notificationId of this.notificationOrder) {
      const notification = this.notifications.get(notificationId);
      if (notification?.sessionId !== sessionId || notification.deliveredAt !== undefined) {
        continue;
      }

      const delivered: TaskNotification = {
        ...notification,
        deliveredAt,
        metadata: cloneMetadata(notification.metadata),
      };
      this.notifications.set(notificationId, delivered);
      drained.push(cloneNotification(delivered));
    }

    for (const notification of this.store?.drainNotifications(sessionId, deliveredAt) ?? []) {
      if (drained.some((item) => item.id === notification.id)) {
        continue;
      }
      this.notifications.set(notification.id, cloneNotification(notification));
      if (!this.notificationOrder.includes(notification.id)) {
        this.notificationOrder.push(notification.id);
      }
      drained.push(cloneNotification(notification));
    }

    return drained;
  }

  getTask(taskId: string): Task | null {
    this.assertNonEmpty(taskId, 'task id');
    const task = this.tasks.get(taskId);
    if (task) {
      return cloneTask(task);
    }
    return this.readTerminalTaskFromStore(taskId);
  }

  private requireTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown background task: ${taskId}`);
    }
    return task;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private nextId(kind: IdKind): string {
    if (this.options.idFactory) {
      return this.options.idFactory(kind);
    }
    this.sequence += 1;
    return `${kind}:${this.now()}:${this.sequence}`;
  }

  private assertNonEmpty(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${label} is required`);
    }
  }

  private publishChanged(taskId: string, sessionId?: string): void {
    if (this.quietDepth > 0) return;
    const data: BackgroundTaskLedgerChangedData = {
      taskId,
      ...(sessionId ? { sessionId } : {}),
    };
    getEventBus().publish('agent', 'background_task_ledger_changed', data, { sessionId });
  }

  private persistIfTerminal(task: Task): void {
    if (!this.store || !isTerminalTaskStatus(task.status)) {
      return;
    }
    this.store.upsertTask(cloneTask(task));
  }

  private persistEvent(task: Task, event: TaskEvent): void {
    if (!this.store || !isTerminalTaskStatus(task.status)) {
      return;
    }
    this.store.appendEvent(cloneTask(task), cloneTaskEvent(event));
  }

  private readTerminalTaskFromStore(taskId: string): Task | null {
    if (!this.store) {
      return null;
    }
    return this.store.loadTerminalTask(taskId);
  }

  private readTerminalTasksFromStore(filter: ListTasksFilter): Task[] {
    if (!this.store) {
      return [];
    }
    return this.store.loadTerminalTasks(filter);
  }
}

function compareTasks(left: Task, right: Task): number {
  if (right.updatedAt !== left.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

function toSet<T extends string>(value?: T | T[]): Set<T> | null {
  if (value === undefined) {
    return null;
  }
  return new Set(Array.isArray(value) ? value : [value]);
}

function cloneMetadata(metadata?: TaskMetadata): TaskMetadata | undefined {
  return metadata ? { ...metadata } : undefined;
}

function cloneProgress(progress?: TaskProgress): TaskProgress | undefined {
  return progress ? { ...progress } : undefined;
}

function cloneFailure(failure?: TaskFailure): TaskFailure | undefined {
  return failure ? { ...failure } : undefined;
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    progress: cloneProgress(task.progress),
    failure: cloneFailure(task.failure),
    metadata: cloneMetadata(task.metadata),
    events: task.events.map(cloneTaskEvent),
    outputRefs: task.outputRefs.map(cloneOutputRef),
  };
}

function cloneTaskEvent(event: TaskEvent): TaskEvent {
  return {
    ...event,
    metadata: cloneMetadata(event.metadata),
  };
}

function cloneOutputRef(outputRef: TaskOutputRef): TaskOutputRef {
  return {
    ...outputRef,
    metadata: cloneMetadata(outputRef.metadata),
  };
}

function cloneNotification(notification: TaskNotification): TaskNotification {
  return {
    ...notification,
    metadata: cloneMetadata(notification.metadata),
  };
}

export function createBackgroundTaskLedger(options?: BackgroundTaskLedgerOptions): BackgroundTaskLedger {
  return new BackgroundTaskLedger(options);
}

let globalLedger: BackgroundTaskLedger | null = null;

export function getBackgroundTaskLedger(): BackgroundTaskLedger {
  if (!globalLedger) {
    globalLedger = createBackgroundTaskLedger();
  }
  return globalLedger;
}

export function resetBackgroundTaskLedgerForTest(): void {
  globalLedger = null;
}
