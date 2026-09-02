import type { AgentEvent, Message, MessageAttachment, TaskProgressData } from '../../../shared/contract';
import type { TaskProgress } from '../../../shared/contract/backgroundTask';
import type { NormalizedToolArtifactMeta } from '../../../shared/contract/artifactBlob';
import type { WorkspaceScope } from '../../../shared/contract/project';
import type { AgentRunOptions } from '../../research/types';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { getTaskManager, type TaskManager, type TaskManagerEvent } from '../../task/TaskManager';
import {
  SessionTaskSlotLedger,
  getSessionTaskConcurrencyPool,
  type SessionTaskSlotLedgerOptions,
  type SessionTaskSlotRecovery,
} from './sessionTaskSlotLedger';
import { getBackgroundTaskLedger } from '../../task/backgroundTaskLedger';
import { createForegroundWake } from './foregroundWake';
import { getConfigService } from '../core/configService';
import { formatSessionTaskSlotRecoveryDetail } from '../../../shared/i18n/sessionTaskSlot';
import type { RuntimeInputMode } from '../../../shared/contract/conversationEnvelope';
import { RUNTIME_INPUT_REDIRECT_LINE, RUNTIME_INPUT_SUPPLEMENT_LINE } from '../../../shared/constants/runtimeInput';

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
  workspaceScope: WorkspaceScope;
  status: SessionCommandTaskStatus;
  attempt: number;
  retryOf?: {
    taskId: string;
    status: Extract<SessionCommandTaskStatus, 'failed' | 'cancelled'>;
    detail?: string;
  };
  createdAt: number;
  updatedAt: number;
  detail?: string;
  summary?: string;
  attachments?: MessageAttachment[];
  options?: AgentRunOptions;
  parentRunId?: string;
  parentTurnId?: string;
  toolCallId?: string;
  progress?: TaskProgress;
  /** 用户在成员视图直接给这个任务补话/改道的次数（N-SUBAGENT-INPUT）；终态唤醒摘要据此带一句。 */
  userInputCount?: number;
}

/** 谁在 steer：团长的 steer_task 工具（缺省）还是用户在成员视图亲手补的话。 */
export interface SteerOptions {
  origin: 'user';
  mode: RuntimeInputMode;
  memberName: string;
  /** 渲染层生成的稳定消息 id / 时间戳：排队路径落库用，与乐观展示同一身份 */
  messageId?: string;
  timestamp?: number;
}

export interface SpawnSessionTaskInput {
  sessionId: string;
  title: string;
  shortName: string;
  laneKey: string;
  submissionKey: string;
  prompt: string;
  workspaceScope: WorkspaceScope;
  queueWhenFull?: boolean;
  attachments?: MessageAttachment[];
  options?: AgentRunOptions;
  parentRunId?: string;
  parentTurnId?: string;
  toolCallId?: string;
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
  /** 排队任务收到用户补话时落主会话记录（运行中路径由运行时 injectSteerMessage 落，不在这里重复） */
  persistMemberInput?: (sessionId: string, message: Message) => Promise<void>;
  wakeForegroundBrain?: (task: SessionCommandTask, status: TerminalTaskStatus) => Promise<void>;
  slotLedgerOptions?: Omit<SessionTaskSlotLedgerOptions, 'onRecovery'>;
  slotRecoveryLocale?: 'zh' | 'en';
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
  private readonly persistMemberInput: NonNullable<SessionCommandCenterDependencies['persistMemberInput']>;
  private readonly wakeForegroundBrain: NonNullable<SessionCommandCenterDependencies['wakeForegroundBrain']>;
  private readonly slotLedgerOptions: NonNullable<SessionCommandCenterDependencies['slotLedgerOptions']>;
  private readonly slotRecoveryLocale?: SessionCommandCenterDependencies['slotRecoveryLocale'];
  private readonly stopAgentEventObservation?: () => void;
  private readonly onTaskEvent = (event: TaskManagerEvent): void => {
    void this.handleTaskEvent(event);
  };

  constructor(
    manager: TaskManager = getTaskManager(),
    dependencies: SessionCommandCenterDependencies = {},
  ) {
    this.manager = manager;
    this.projectTerminalResult = dependencies.projectTerminalResult ?? projectTerminalResult;
    this.persistMemberInput = dependencies.persistMemberInput
      ?? ((sessionId, message) => getSessionManager().addMessageToSession(sessionId, message));
    this.wakeForegroundBrain = dependencies.wakeForegroundBrain ?? createForegroundWake();
    this.slotLedgerOptions = dependencies.slotLedgerOptions ?? {};
    this.slotRecoveryLocale = dependencies.slotRecoveryLocale;
    for (const eventName of TASK_LIFECYCLE_EVENTS) {
      this.manager.on(eventName, this.onTaskEvent);
    }
    if (typeof this.manager.observeAgentEvents === 'function') {
      this.stopAgentEventObservation = this.manager.observeAgentEvents((sessionId, event, taskId) => {
        this.handleAgentProgressEvent(sessionId, event, taskId);
      });
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

    const retryOfId = admission.slot.attempt > 1
      ? this.previousTaskId(input.sessionId, input.submissionKey, admission.slot.workItemId)
      : undefined;
    const retryOf = retryOfId ? this.tasks(input.sessionId).get(retryOfId) : undefined;
    const now = Date.now();
    const task: SessionCommandTask = {
      id,
      sessionId: input.sessionId,
      title: input.title,
      shortName: input.shortName,
      laneKey: input.laneKey,
      submissionKey: input.submissionKey,
      prompt: input.prompt,
      workspaceScope: input.workspaceScope,
      status: admission.outcome === 'started' ? 'running' : 'queued',
      attempt: admission.slot.attempt,
      ...(retryOf && (retryOf.status === 'failed' || retryOf.status === 'cancelled')
        ? {
          retryOf: {
            taskId: retryOf.id,
            status: retryOf.status,
            ...(retryOf.detail ? { detail: retryOf.detail } : {}),
          },
        }
        : {}),
      createdAt: now,
      updatedAt: now,
      attachments: input.attachments,
      options: input.options,
      parentRunId: input.parentRunId,
      parentTurnId: input.parentTurnId,
      toolCallId: input.toolCallId,
    };
    this.tasks(input.sessionId).set(id, task);
    this.projectTask(task);
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

  async steer(
    sessionId: string,
    target: string | undefined,
    instruction: string,
    steerOptions?: SteerOptions,
  ): Promise<SessionTaskReferenceResult> {
    const resolution = this.resolve(sessionId, target);
    if (resolution.outcome !== 'resolved') return resolution;
    // resolve() 经 list() 拿到的是快照拷贝；改 prompt / 计数必须落到台账里那份，否则排队任务
    // 开工时读到的还是老任务书（此前团长 steer_task 排队任务就是这样静默丢的）。
    const task = this.tasks(sessionId).get(resolution.task.id) ?? resolution.task;
    if (steerOptions?.origin === 'user') task.userInputCount = (task.userInputCount ?? 0) + 1;
    if (task.status === 'queued') {
      // 还没开工：写进任务书。改道要带改道指令行，否则开工时仍沿用原思路
      task.prompt = steerOptions?.mode === 'redirect'
        ? `${task.prompt}\n\n改道要求：${instruction}\n${RUNTIME_INPUT_REDIRECT_LINE}`
        : `${task.prompt}\n\n补充要求：${instruction}`;
      task.updatedAt = Date.now();
      if (steerOptions) {
        // 主对话落一条 isMeta+memberInput 记录（刷新/回放/团长汇总都看得见；运行中路径由运行时落）
        const timestamp = steerOptions.timestamp ?? task.updatedAt;
        await this.persistMemberInput(sessionId, {
          id: steerOptions.messageId ?? `member-input-${task.id}-${timestamp}`,
          role: 'user',
          content: instruction,
          timestamp,
          isMeta: true,
          source: 'system',
          metadata: {
            workbench: { runtimeInputMode: steerOptions.mode },
            memberInput: { memberId: task.id, memberName: steerOptions.memberName, mode: steerOptions.mode },
          },
        });
      }
      return { outcome: 'resolved', task: { ...task } };
    }
    // 用户亲手补的话：与主输入框同一套两档指令行（补充/改道），并把 runtimeInputMode + memberInput
    // 挂到落库元数据上——改道由运行时出回执，主对话按 memberInput 折叠成一行记录。
    const outcome = steerOptions
      ? await this.manager.interruptBackgroundTask(
        task.id,
        instruction,
        task.attachments,
        {
          ...(task.options ?? { mode: 'normal' }),
          turnSystemContext: [
            ...(task.options?.turnSystemContext ?? []),
            steerOptions.mode === 'redirect' ? RUNTIME_INPUT_REDIRECT_LINE : RUNTIME_INPUT_SUPPLEMENT_LINE,
          ],
        },
        {
          workbench: { runtimeInputMode: steerOptions.mode },
          memberInput: { memberId: task.id, memberName: steerOptions.memberName, mode: steerOptions.mode },
        },
      )
      : await this.manager.interruptBackgroundTask(
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
    this.stopAgentEventObservation?.();
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
      ledger = new SessionTaskSlotLedger(sessionId, getSessionTaskConcurrencyPool(), {
        ...this.slotLedgerOptions,
        onRecovery: (recovery) => this.handleSlotRecovery(sessionId, recovery),
      });
      this.ledgers.set(sessionId, ledger);
    }
    return ledger;
  }

  private handleSlotRecovery(sessionId: string, recovery: SessionTaskSlotRecovery): void {
    let locale = this.slotRecoveryLocale ?? 'zh';
    if (!this.slotRecoveryLocale) {
      try {
        locale = getConfigService().getSettings().ui.language;
      } catch (error) {
        logger.warn('Failed to read UI locale for task slot recovery; using Chinese fallback', {
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      for (const { slot, occupiedMs } of recovery.expired) {
        const task = this.tasksBySession.get(sessionId)?.get(slot.workItemId);
        if (!task || TERMINAL.has(task.status)) continue;
        const detail = formatSessionTaskSlotRecoveryDetail({
          taskLabel: task.shortName || task.title,
          laneKey: slot.laneKey,
          occupiedMs,
          locale,
        });
        void this.settle(task, 'failed', detail);
      }
    } finally {
      for (const slot of recovery.startable) {
        const next = this.tasks(sessionId).get(slot.workItemId);
        if (next) this.launch(next);
      }
    }
  }

  private launch(task: SessionCommandTask): void {
    task.status = 'running';
    task.updatedAt = Date.now();
    this.projectTask(task);
    const failLaunch = (error: unknown): void => {
      void this.settle(task, 'failed', error instanceof Error ? error.message : String(error));
    };
    try {
      void this.manager.startBackgroundTask(
        task.id,
        task.sessionId,
        task.prompt,
        task.attachments,
        {
          ...task.options,
          mode: task.options?.mode ?? 'normal',
          runRegistration: 'auxiliary',
          runId: task.id,
          parentRunId: task.parentRunId,
        },
        undefined,
        task.workspaceScope,
      ).catch(failLaunch);
    } catch (error) {
      failLaunch(error);
    }
  }

  private async handleTaskEvent(event: TaskManagerEvent): Promise<void> {
    const data = event.data as {
      taskId?: unknown;
      error?: unknown;
      conclusion?: unknown;
      artifacts?: unknown;
    } | undefined;
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
      const artifacts = Array.isArray(data?.artifacts)
        ? data.artifacts as NormalizedToolArtifactMeta[]
        : undefined;
      await this.settle(task, 'completed', conclusion, artifacts);
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

  private handleAgentProgressEvent(sessionId: string, event: AgentEvent, taskId?: string): void {
    if (event.type !== 'task_progress' || !taskId) return;
    const task = this.tasksBySession.get(sessionId)?.get(taskId);
    if (!task || TERMINAL.has(task.status)) return;
    const data = event.data as TaskProgressData | undefined;
    if (!data?.tool) return;

    const current = data.toolIndex === undefined ? task.progress?.current : data.toolIndex + 1;
    task.progress = {
      ...task.progress,
      ...(current === undefined ? {} : { current }),
      ...(data.toolTotal === undefined ? {} : { total: data.toolTotal }),
      ...(data.progress === undefined ? {} : { percent: data.progress }),
      ...(data.step ? { label: data.step } : {}),
      lastToolStep: {
        tool: data.tool,
        ...(data.toolIndex === undefined ? {} : { toolIndex: data.toolIndex }),
        ...(data.toolTotal === undefined ? {} : { toolTotal: data.toolTotal }),
        ...(data.target ? { target: data.target } : {}),
        at: Date.now(),
      },
    };
    task.updatedAt = Date.now();
    this.projectTask(task);
  }

  private async settle(
    task: SessionCommandTask,
    status: TerminalTaskStatus,
    detail?: string,
    artifacts?: NormalizedToolArtifactMeta[],
  ): Promise<void> {
    if (TERMINAL.has(task.status)) return;
    task.status = status;
    task.detail = detail;
    task.summary = compactSummary(
      detail,
      status === 'completed' ? '任务已完成。' : status === 'cancelled' ? '任务已取消。' : '任务执行失败。',
    );
    task.updatedAt = Date.now();
    this.projectTask(task);
    if (status === 'completed' && artifacts?.length) {
      try {
        this.projectOutputRefs(task, artifacts);
      } catch (error) {
        logger.warn('Failed to project text command task output references', {
          taskId: task.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 账本落终态必须**先于**下面那个 await：task.status 在上面已经同步变成 failed 且投影出去了，
    // 而账本要等投影 Promise 落地才记终态。中间这段窗口里，前台从 task_status 已经看得到
    // failed，立刻用同一 submissionKey 重试——账本里那个 slot 还是 running，admit() 返回
    // reused，重试静默失效。正是这条改动要消灭的形态，只是窗口更窄。
    const startable = this.ledger(task.sessionId).settle(task.id, status);

    try {
      await this.projectTerminalResult(task, status);
      void this.wakeForegroundBrain(task, status).catch((error) => {
        logger.warn('Failed to wake text foreground brain after task settlement', {
          taskId: task.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      logger.warn('Failed to project text command task result', {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    for (const slot of startable) {
      const next = this.tasks(task.sessionId).get(slot.workItemId);
      if (next) this.launch(next);
    }
  }

  private projectTask(task: SessionCommandTask): void {
    try {
      getBackgroundTaskLedger().upsertTask({
        id: task.id,
        kind: 'session_command_task',
        source: 'session_command_center',
        sessionId: task.sessionId,
        parentTurnId: task.parentTurnId,
        toolCallId: task.toolCallId,
        runId: task.id,
        title: task.title,
        summary: task.summary,
        status: task.status === 'cancelling' ? 'running' : task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        startedAt: task.status === 'running' ? task.updatedAt : undefined,
        completedAt: TERMINAL.has(task.status) ? task.updatedAt : undefined,
        progress: task.progress,
        ...(task.status === 'failed' && task.detail
          ? { failure: { message: task.detail, reason: 'session_command_task_failed' } }
          : {}),
        metadata: {
          shortName: task.shortName,
          laneKey: task.laneKey,
          submissionKey: task.submissionKey,
          attempt: task.attempt,
          retryOf: task.retryOf,
          parentRunId: task.parentRunId,
          childRunId: task.id,
        },
      });
    } catch (error) {
      logger.warn('Failed to project session command task into background ledger', {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private projectOutputRefs(task: SessionCommandTask, artifacts: NormalizedToolArtifactMeta[]): void {
    const ledger = getBackgroundTaskLedger();
    artifacts.forEach((artifact, index) => {
      ledger.addOutputRef({
        id: `${task.id}:output:${index + 1}`,
        taskId: task.id,
        type: artifact.path ? 'file' : 'url',
        label: artifact.label,
        path: artifact.path,
        uri: artifact.url,
        mimeType: artifact.mimeType,
        size: artifact.sizeBytes,
        createdAt: task.updatedAt,
        metadata: {
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          role: artifact.role,
          sourceTool: artifact.sourceTool,
          sha256: artifact.sha256,
        },
      });
    });
  }

  private previousTaskId(sessionId: string, submissionKey: string, currentTaskId: string): string | undefined {
    const previous = this.list(sessionId)
      .filter((task) => task.submissionKey === submissionKey && task.id !== currentTaskId)
      .at(-1);
    return previous?.id;
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
