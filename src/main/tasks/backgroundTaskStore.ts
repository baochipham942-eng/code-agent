import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { existsSync } from 'fs';
import type {
  ListTasksFilter,
  Task,
  TaskEvent,
  TaskFailure,
  TaskMetadata,
  TaskNotification,
  TaskStatus,
} from '../../shared/contract/backgroundTask';
import { isTerminalTaskStatus } from '../../shared/contract/backgroundTask';
import { buildBackgroundTaskRecoveryPlan } from './backgroundTaskRecoveryPlan';

interface PersistedTaskRow {
  task_json: string;
}

interface PersistedNotificationRow {
  notification_json: string;
}

interface CronTerminalRow {
  id: string;
  job_id: string;
  session_id?: string | null;
  status: 'completed' | 'failed' | 'cancelled';
  scheduled_at: number;
  started_at?: number | null;
  completed_at?: number | null;
  duration?: number | null;
  result?: string | null;
  error?: string | null;
  retry_attempt: number;
  exit_code?: number | null;
  job_name?: string | null;
  schedule_type?: string | null;
  job_action?: string | null;
}

export interface BackgroundTaskStore {
  upsertTask(task: Task): void;
  appendEvent(task: Task, event: TaskEvent): void;
  queueNotification(notification: TaskNotification): void;
  listBySession(sessionId: string, filter?: ListTasksFilter): Task[];
  drainNotifications(sessionId: string, deliveredAt: number): TaskNotification[];
  persistTerminalTask(task: Task): void;
  loadTerminalTask(taskId: string): Task | null;
  loadTerminalTasks(filter?: ListTasksFilter): Task[];
}

export class NullBackgroundTaskStore implements BackgroundTaskStore {
  upsertTask(_task: Task): void {}

  appendEvent(_task: Task, _event: TaskEvent): void {}

  queueNotification(_notification: TaskNotification): void {}

  listBySession(_sessionId: string, _filter: ListTasksFilter = {}): Task[] {
    return [];
  }

  drainNotifications(_sessionId: string, _deliveredAt: number): TaskNotification[] {
    return [];
  }

  persistTerminalTask(_task: Task): void {}

  loadTerminalTask(_taskId: string): Task | null {
    return null;
  }

  loadTerminalTasks(_filter: ListTasksFilter = {}): Task[] {
    return [];
  }
}

export class SqliteBackgroundTaskStore implements BackgroundTaskStore {
  constructor(private readonly db: BetterSqliteDatabase) {
    this.ensureSchema();
  }

  upsertTask(task: Task): void {
    this.persistTaskSnapshot(task);
  }

  appendEvent(task: Task, _event: TaskEvent): void {
    this.upsertTask(task);
  }

  queueNotification(notification: TaskNotification): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO background_task_notifications
        (id, task_id, session_id, type, created_at, delivered_at, notification_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      notification.id,
      notification.taskId,
      notification.sessionId,
      notification.type,
      notification.createdAt,
      notification.deliveredAt ?? null,
      JSON.stringify(notification),
    );
  }

  listBySession(sessionId: string, filter: ListTasksFilter = {}): Task[] {
    return this.loadTerminalTasks({ ...filter, sessionId });
  }

  drainNotifications(sessionId: string, deliveredAt: number): TaskNotification[] {
    const rows = this.db.prepare(`
      SELECT notification_json
      FROM background_task_notifications
      WHERE session_id = ? AND delivered_at IS NULL
      ORDER BY created_at ASC
    `).all(sessionId) as PersistedNotificationRow[];

    const notifications = rows
      .map((row) => parsePersistedNotification(row.notification_json))
      .filter((notification): notification is TaskNotification => Boolean(notification))
      .map((notification) => ({
        ...notification,
        deliveredAt: notification.deliveredAt ?? deliveredAt,
        metadata: notification.metadata ? { ...notification.metadata } : undefined,
      }));

    for (const notification of notifications) {
      this.db.prepare(`
        UPDATE background_task_notifications
        SET delivered_at = ?, notification_json = ?
        WHERE id = ?
      `).run(
        notification.deliveredAt ?? deliveredAt,
        JSON.stringify(notification),
        notification.id,
      );
    }

    return notifications;
  }

  persistTerminalTask(task: Task): void {
    if (!isTerminalTaskStatus(task.status)) {
      return;
    }
    this.persistTaskSnapshot(task);
  }

  private persistTaskSnapshot(task: Task): void {

    this.db.prepare(`
      INSERT OR REPLACE INTO background_task_terminal_tasks
        (id, source, kind, session_id, status, updated_at, completed_at, task_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.source,
      task.kind ?? null,
      task.sessionId ?? null,
      task.status,
      task.updatedAt,
      task.completedAt ?? null,
      JSON.stringify(task),
    );
  }

  loadTerminalTask(taskId: string): Task | null {
    if (taskId.startsWith('cron:')) {
      return this.loadCronTerminalTask(taskId);
    }

    const row = this.db.prepare(`
      SELECT task_json
      FROM background_task_terminal_tasks
      WHERE id = ?
      LIMIT 1
    `).get(taskId) as PersistedTaskRow | undefined;

    return row ? parsePersistedTask(row.task_json) : null;
  }

  loadTerminalTasks(filter: ListTasksFilter = {}): Task[] {
    const tasks = [
      ...this.loadPersistedTerminalTasks(),
      ...this.loadCronTerminalTasks(),
    ].filter((task) => matchesTaskFilter(task, filter));

    return tasks.sort(compareTasks).map(cloneTask);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS background_task_terminal_tasks (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        kind TEXT,
        session_id TEXT,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        task_json TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_background_task_terminal_source_status
      ON background_task_terminal_tasks(source, status, updated_at DESC)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_background_task_terminal_session
      ON background_task_terminal_tasks(session_id, updated_at DESC)
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS background_task_notifications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        notification_json TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_background_task_notifications_session
      ON background_task_notifications(session_id, delivered_at, created_at ASC)
    `);
  }

  private loadPersistedTerminalTasks(): Task[] {
    const rows = this.db.prepare(`
      SELECT task_json
      FROM background_task_terminal_tasks
      ORDER BY updated_at DESC
    `).all() as PersistedTaskRow[];

    return rows
      .map((row) => parsePersistedTask(row.task_json))
      .filter((task): task is Task => Boolean(task));
  }

  private loadCronTerminalTask(taskId: string): Task | null {
    const executionId = taskId.replace(/^cron:/, '');
    const task = this.loadCronTerminalTasks()
      .find((candidate) => candidate.id === `cron:${executionId}`);
    return task ? cloneTask(task) : null;
  }

  private loadCronTerminalTasks(): Task[] {
    if (!this.hasTable('cron_executions')) {
      return [];
    }

    const joinJobs = this.hasTable('cron_jobs');
    const rows = this.db.prepare(`
      SELECT
        e.id,
        e.job_id,
        e.session_id,
        e.status,
        e.scheduled_at,
        e.started_at,
        e.completed_at,
        e.duration,
        e.result,
        e.error,
        e.retry_attempt,
        e.exit_code
        ${joinJobs ? ', j.name AS job_name, j.schedule_type, j.action AS job_action' : ''}
      FROM cron_executions e
      ${joinJobs ? 'LEFT JOIN cron_jobs j ON j.id = e.job_id' : ''}
      WHERE e.status IN ('completed', 'failed', 'cancelled')
      ORDER BY e.scheduled_at DESC
    `).all() as CronTerminalRow[];

    return rows.map(mapCronExecutionToTask);
  }

  private hasTable(tableName: string): boolean {
    const row = this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `).get(tableName) as { name?: string } | undefined;
    return row?.name === tableName;
  }
}

function parsePersistedTask(value: string): Task | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isTaskLike(parsed)) {
      return recoverPersistedRunningTask(cloneTask(parsed));
    }
  } catch {
    return null;
  }
  return null;
}

function recoverPersistedRunningTask(task: Task): Task {
  if (task.status !== 'running') {
    return task;
  }

  const metadata = {
    ...(task.metadata ?? {}),
    originalStatus: 'running',
    recoveredAtMs: Date.now(),
  };

  if (isNeoManagedTask(task) && hasUsableOutputRef(task) && isLiveProcessReferenced(task)) {
    const recoveryStatus = 'running-recovered';
    const outputFile = getPrimaryLogPath(task);
    return {
      ...task,
      metadata: {
        ...metadata,
        recoveryStatus,
        recoveryPlan: buildBackgroundTaskRecoveryPlan({
          status: 'running',
          recoveryStatus,
          outputFile,
        }),
      },
    };
  }

  const recoveryStatus = 'dead-log-only';
  const outputFile = getPrimaryLogPath(task);
  return {
    ...task,
    status: 'orphaned',
    completedAt: task.completedAt ?? task.updatedAt,
    failure: task.failure ?? {
      message: 'Task process was not recovered after restart; log is available only',
      category: 'dead_log_only',
    },
    metadata: {
      ...metadata,
      recoveryStatus,
      recoveryPlan: buildBackgroundTaskRecoveryPlan({
        status: 'orphaned',
        recoveryStatus,
        outputFile,
      }),
    },
  };
}

function getPrimaryLogPath(task: Task): string | undefined {
  const ref = task.outputRefs.find((candidate) => candidate.type === 'log' && typeof candidate.path === 'string');
  return ref?.path;
}

function isNeoManagedTask(task: Task): boolean {
  return task.source === 'shell' ||
    task.source === 'pty' ||
    task.metadata?.createdBy === 'neo' ||
    task.metadata?.managedBy === 'neo';
}

function hasUsableOutputRef(task: Task): boolean {
  return task.outputRefs.some((ref) => typeof ref.path === 'string' && existsSync(ref.path));
}

function isLiveProcessReferenced(task: Task): boolean {
  const pid = readPositiveNumber(task.metadata?.pid ?? task.metadata?.processId);
  if (pid !== null && isProcessAlive(pid)) {
    return true;
  }

  const processGroupId = readPositiveNumber(task.metadata?.processGroupId ?? task.metadata?.pgid);
  if (processGroupId !== null && process.platform !== 'win32' && isProcessGroupAlive(processGroupId)) {
    return true;
  }

  return false;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

function parsePersistedNotification(value: string): TaskNotification | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isNotificationLike(parsed)) {
      return {
        ...parsed,
        metadata: parsed.metadata ? { ...parsed.metadata } : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function mapCronExecutionToTask(row: CronTerminalRow): Task {
  const action = parseJsonObject(row.job_action);
  const result = parseJsonValue(row.result);
  const metadata: TaskMetadata = {
    jobId: row.job_id,
    executionId: row.id,
    retryAttempt: row.retry_attempt,
    scheduleType: row.schedule_type ?? undefined,
    actionType: typeof action?.type === 'string' ? action.type : undefined,
    result,
  };
  const status = mapCronStatus(row.status);
  const failure = buildCronFailure(status, row);

  return {
    id: `cron:${row.id}`,
    kind: 'cron',
    sessionId: row.session_id ?? undefined,
    source: 'cron',
    title: row.job_name || `Cron ${row.job_id}`,
    summary: row.error ?? undefined,
    command: typeof action?.command === 'string' ? action.command : undefined,
    cwd: typeof action?.cwd === 'string' ? action.cwd : undefined,
    status,
    createdAt: row.scheduled_at,
    updatedAt: row.completed_at ?? row.started_at ?? row.scheduled_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    durationMs: row.duration ?? undefined,
    failure,
    metadata: pruneUndefined(metadata),
    events: [],
    outputRefs: [],
  };
}

function mapCronStatus(status: CronTerminalRow['status']): TaskStatus {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'completed';
}

function buildCronFailure(status: TaskStatus, row: CronTerminalRow): TaskFailure | undefined {
  if (status !== 'failed') {
    return undefined;
  }
  return {
    message: row.error || 'Cron execution failed',
    exitCode: row.exit_code ?? undefined,
    category: 'cron_failed',
  };
}

function parseJsonObject(value?: string | null): Record<string, unknown> | undefined {
  const parsed = parseJsonValue(value);
  return isRecord(parsed) ? parsed : undefined;
}

function parseJsonValue(value?: string | null): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isTaskLike(value: unknown): value is Task {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.source === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    Array.isArray(value.events) &&
    Array.isArray(value.outputRefs)
  );
}

function isNotificationLike(value: unknown): value is TaskNotification {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.taskId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.type === 'string' &&
    typeof value.message === 'string' &&
    typeof value.createdAt === 'number'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function matchesTaskFilter(task: Task, filter: ListTasksFilter): boolean {
  const statuses = toSet(filter.status);
  const sources = toSet(filter.source);
  return (
    (!filter.sessionId || task.sessionId === filter.sessionId) &&
    (!statuses || statuses.has(task.status)) &&
    (!sources || sources.has(task.source))
  );
}

function toSet<T extends string>(value?: T | T[]): Set<T> | null {
  if (value === undefined) {
    return null;
  }
  return new Set(Array.isArray(value) ? value : [value]);
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
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

function cloneTask(task: Task): Task {
  return {
    ...task,
    progress: task.progress ? { ...task.progress } : undefined,
    failure: task.failure ? { ...task.failure } : undefined,
    metadata: task.metadata ? { ...task.metadata } : undefined,
    events: task.events.map((event) => ({
      ...event,
      metadata: event.metadata ? { ...event.metadata } : undefined,
    })),
    outputRefs: task.outputRefs.map((outputRef) => ({
      ...outputRef,
      metadata: outputRef.metadata ? { ...outputRef.metadata } : undefined,
    })),
  };
}
