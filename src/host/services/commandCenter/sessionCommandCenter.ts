import type { MessageAttachment } from '../../../shared/contract';
import type { AgentRunOptions } from '../../research/types';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { getTaskManager, type TaskManager, type TaskManagerEvent } from '../../task/TaskManager';
import {
  SessionTaskSlotLedger,
  getSessionTaskConcurrencyPool,
} from './sessionTaskSlotLedger';

const logger = createLogger('SessionCommandCenter');

type SessionCommandTaskStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export interface SessionCommandTask {
  id: string;
  sessionId: string;
  title: string;
  shortName: string;
  laneKey: string;
  submissionKey: string;
  prompt: string;
  status: SessionCommandTaskStatus;
  createdAt: number;
  updatedAt: number;
  detail?: string;
  summary?: string;
  attachments?: MessageAttachment[];
  options?: AgentRunOptions;
}

export interface SpawnSessionTaskInput {
  sessionId: string;
  title: string;
  shortName: string;
  laneKey: string;
  submissionKey: string;
  prompt: string;
  queueWhenFull?: boolean;
  attachments?: MessageAttachment[];
  options?: AgentRunOptions;
}

export type SpawnSessionTaskResult =
  | { outcome: 'started' | 'queued' | 'reused'; task: SessionCommandTask }
  | { outcome: 'requires_choice'; active: SessionCommandTask[] };

export type SessionTaskReferenceResult =
  | { outcome: 'resolved'; task: SessionCommandTask }
  | { outcome: 'missing' }
  | { outcome: 'ambiguous'; candidates: SessionCommandTask[] };

const TERMINAL = new Set<SessionCommandTaskStatus>(['completed', 'failed', 'cancelled']);
const TASK_LIFECYCLE_EVENTS = ['task_started', 'task_completed', 'task_error', 'task_cancelled'] as const;

type TerminalTaskStatus = Extract<SessionCommandTaskStatus, 'completed' | 'failed' | 'cancelled'>;

interface SessionCommandCenterDependencies {
  projectTerminalResult?: (task: SessionCommandTask, status: TerminalTaskStatus) => Promise<void>;
}

function taskId(): string {
  return `session-work-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function compactSummary(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return Array.from(normalized).slice(0, 240).join('');
}

export class SessionCommandCenter {
  private readonly tasksBySession = new Map<string, Map<string, SessionCommandTask>>();
  private readonly ledgers = new Map<string, SessionTaskSlotLedger>();
  private readonly manager: TaskManager;
  private readonly projectTerminalResult: NonNullable<SessionCommandCenterDependencies['projectTerminalResult']>;
  private readonly onTaskEvent = (event: TaskManagerEvent): void => {
    void this.handleTaskEvent(event);
  };

  constructor(
    manager: TaskManager = getTaskManager(),
    dependencies: SessionCommandCenterDependencies = {},
  ) {
    this.manager = manager;
    this.projectTerminalResult = dependencies.projectTerminalResult ?? projectTerminalResult;
    for (const eventName of TASK_LIFECYCLE_EVENTS) {
      this.manager.on(eventName, this.onTaskEvent);
    }
  }

  async spawn(input: SpawnSessionTaskInput): Promise<SpawnSessionTaskResult> {
    const ledger = this.ledger(input.sessionId);
    const id = taskId();
    const admission = ledger.admit({
      workItemId: id,
      sessionId: input.sessionId,
      laneKey: input.laneKey,
      submissionKey: input.submissionKey,
    }, { queueWhenFull: input.queueWhenFull });

    if (admission.outcome === 'requires_choice') {
      return { outcome: 'requires_choice', active: this.active(input.sessionId) };
    }
    if (admission.outcome === 'reused') {
      const reused = this.tasks(input.sessionId).get(admission.slot.workItemId);
      if (!reused) throw new Error(`Reused task ${admission.slot.workItemId} is missing from the session ledger`);
      return { outcome: 'reused', task: { ...reused } };
    }

    const now = Date.now();
    const task: SessionCommandTask = {
      id,
      sessionId: input.sessionId,
      title: input.title,
      shortName: input.shortName,
      laneKey: input.laneKey,
      submissionKey: input.submissionKey,
      prompt: input.prompt,
      status: admission.outcome === 'started' ? 'running' : 'queued',
      createdAt: now,
      updatedAt: now,
      attachments: input.attachments,
      options: input.options,
    };
    this.tasks(input.sessionId).set(id, task);
    if (admission.outcome === 'started') this.launch(task);
    return { outcome: admission.outcome, task: { ...task } };
  }

  list(sessionId: string): SessionCommandTask[] {
    return [...this.tasks(sessionId).values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((task) => ({ ...task }));
  }

  active(sessionId: string): SessionCommandTask[] {
    return this.list(sessionId).filter((task) => !TERMINAL.has(task.status));
  }

  resolve(sessionId: string, target?: string): SessionTaskReferenceResult {
    const active = this.active(sessionId);
    const normalized = target?.trim().toLocaleLowerCase();
    if (!normalized) {
      if (active.length === 1) return { outcome: 'resolved', task: active[0] };
      if (active.length === 0) return { outcome: 'missing' };
      return { outcome: 'ambiguous', candidates: active };
    }

    const ordinal = Number(normalized);
    const exact = active.filter((task, index) => (
      task.id.toLocaleLowerCase() === normalized
      || task.shortName.toLocaleLowerCase() === normalized
      || task.title.toLocaleLowerCase() === normalized
      || (Number.isInteger(ordinal) && ordinal === index + 1)
    ));
    if (exact.length === 1) return { outcome: 'resolved', task: exact[0] };
    if (exact.length > 1) return { outcome: 'ambiguous', candidates: exact };

    const partial = active.filter((task) => (
      task.shortName.toLocaleLowerCase().includes(normalized)
      || task.title.toLocaleLowerCase().includes(normalized)
    ));
    if (partial.length === 1) return { outcome: 'resolved', task: partial[0] };
    if (partial.length > 1) return { outcome: 'ambiguous', candidates: partial };
    return { outcome: 'missing' };
  }

  async steer(sessionId: string, target: string | undefined, instruction: string): Promise<SessionTaskReferenceResult> {
    const resolution = this.resolve(sessionId, target);
    if (resolution.outcome !== 'resolved') return resolution;
    const task = resolution.task;
    if (task.status === 'queued') {
      task.prompt = `${task.prompt}\n\n补充要求：${instruction}`;
      task.updatedAt = Date.now();
      return { outcome: 'resolved', task: { ...task } };
    }
    const outcome = await this.manager.interruptBackgroundTask(
      task.id,
      instruction,
      task.attachments,
      task.options,
    );
    if (!outcome) return { outcome: 'missing' };
    task.updatedAt = Date.now();
    return { outcome: 'resolved', task: { ...task } };
  }

  async cancel(sessionId: string, target?: string): Promise<SessionTaskReferenceResult> {
    const resolution = this.resolve(sessionId, target);
    if (resolution.outcome !== 'resolved') return resolution;
    const task = resolution.task;
    if (task.status === 'queued') {
      await this.settle(task, 'cancelled', '任务在开始前被取消。');
      return { outcome: 'resolved', task: { ...task } };
    }
    const accepted = await this.manager.cancelBackgroundTask(task.id);
    if (!accepted) return { outcome: 'missing' };
    task.status = 'cancelling';
    task.updatedAt = Date.now();
    return { outcome: 'resolved', task: { ...task } };
  }

  dispose(): void {
    for (const eventName of TASK_LIFECYCLE_EVENTS) {
      this.manager.off(eventName, this.onTaskEvent);
    }
    for (const ledger of this.ledgers.values()) ledger.dispose();
  }

  private tasks(sessionId: string): Map<string, SessionCommandTask> {
    let tasks = this.tasksBySession.get(sessionId);
    if (!tasks) {
      tasks = new Map();
      this.tasksBySession.set(sessionId, tasks);
    }
    return tasks;
  }

  private ledger(sessionId: string): SessionTaskSlotLedger {
    let ledger = this.ledgers.get(sessionId);
    if (!ledger) {
      ledger = new SessionTaskSlotLedger(sessionId, getSessionTaskConcurrencyPool());
      this.ledgers.set(sessionId, ledger);
    }
    return ledger;
  }

  private launch(task: SessionCommandTask): void {
    task.status = 'running';
    task.updatedAt = Date.now();
    void this.manager.startBackgroundTask(
      task.id,
      task.sessionId,
      task.prompt,
      task.attachments,
      task.options,
      undefined,
    ).catch((error) => {
      void this.settle(task, 'failed', error instanceof Error ? error.message : String(error));
    });
  }

  private async handleTaskEvent(event: TaskManagerEvent): Promise<void> {
    const data = event.data as { taskId?: unknown; error?: unknown; conclusion?: unknown } | undefined;
    const id = typeof data?.taskId === 'string' ? data.taskId : undefined;
    if (!id) return;
    const task = this.tasksBySession.get(event.sessionId)?.get(id);
    if (!task) return;

    if (event.type === 'task_started') {
      task.status = 'running';
      task.updatedAt = Date.now();
      return;
    }
    if (event.type === 'task_completed') {
      const conclusion = typeof data?.conclusion === 'string' ? data.conclusion : undefined;
      await this.settle(task, 'completed', conclusion);
      return;
    }
    if (event.type === 'task_error') {
      await this.settle(task, 'failed', typeof data?.error === 'string' ? data.error : '执行失败');
      return;
    }
    if (event.type === 'task_cancelled') {
      await this.settle(task, 'cancelled', '任务已取消。');
    }
  }

  private async settle(
    task: SessionCommandTask,
    status: TerminalTaskStatus,
    detail?: string,
  ): Promise<void> {
    if (TERMINAL.has(task.status)) return;
    task.status = status;
    task.detail = detail;
    task.summary = compactSummary(
      detail,
      status === 'completed' ? '任务已完成。' : status === 'cancelled' ? '任务已取消。' : '任务执行失败。',
    );
    task.updatedAt = Date.now();

    try {
      await this.projectTerminalResult(task, status);
    } catch (error) {
      logger.warn('Failed to project text command task result', {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    for (const slot of this.ledger(task.sessionId).settle(task.id)) {
      const next = this.tasks(task.sessionId).get(slot.workItemId);
      if (next) this.launch(next);
    }
  }
}

async function projectTerminalResult(
  task: SessionCommandTask,
  status: TerminalTaskStatus,
): Promise<void> {
  await getSessionManager().addMessageToSession(task.sessionId, {
    id: `session-task-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'system',
    content: `[任务结果] ${task.shortName}｜${status}｜${task.summary}`,
    timestamp: Date.now(),
    metadata: {
      backgroundTaskResult: {
        source: 'agent-result',
        taskId: task.id,
        shortName: task.shortName,
        status,
        summary: task.summary ?? '',
      },
    },
  });
}

let singleton: SessionCommandCenter | null = null;

export function getSessionCommandCenter(): SessionCommandCenter {
  if (!singleton) singleton = new SessionCommandCenter();
  return singleton;
}

export function resetSessionCommandCenterForTest(): void {
  singleton?.dispose();
  singleton = null;
}
