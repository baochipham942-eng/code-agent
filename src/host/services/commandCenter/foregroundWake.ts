import type { Message } from '../../../shared/contract';
import type { SystemEventMessageMetadata } from '../../../shared/contract/systemEventRegistry';
import {
  MAX_CONSECUTIVE_WAKES,
  SESSION_COMMAND_CENTER_WAKE_MAX_ITERATIONS,
} from '../../../shared/constants/sessionCommandCenter';
import type { AgentOrchestrator } from '../../agent/agentOrchestrator';
import type { AgentRunOptions } from '../../research/types';
import { getPermissionModeManager } from '../../permissions/modes';
import { getTaskManager } from '../../task/TaskManager';
import { withSessionCommandCenterBrain } from '../../app/sessionCommandCenterBrain';
import { getDatabase } from '../core/databaseService';
import { QueuedInputRepository } from '../core/repositories/QueuedInputRepository';
import { getSessionManager, type SessionWithMessages } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import type { SessionCommandTask } from './sessionCommandCenter';

import { WAKE_NOOP_TOOL_NAME } from '../../../shared/constants/agent';

const FOREGROUND_WAKE_CONTRACT = [
  '<background_task_hidden_wake>',
  '这一轮由后台任务终态触发，不是用户正在等待你确认的消息。',
  '不要写“收到”“好的”等承接语，不要把后台结果当成用户消息引用。',
  '只有存在对用户有信息量的交付物、结论，或失败后需要用户决定时，才输出文字；直接给结论。',
  '需要继续执行时调用 delegate_task。',
  `没有值得告知用户的内容时，只调用 ${WAKE_NOOP_TOOL_NAME}，不要输出任何文字。`,
  '</background_task_hidden_wake>',
].join('\n');

type WakeStatus = 'completed' | 'failed' | 'cancelled';

interface WakeTaskManager {
  getSessionState(sessionId: string): { status: string };
  getWaitingQueue(): string[];
  hasActivePrimaryRun(sessionId: string): boolean;
  getOrCreateCurrentOrchestrator(sessionId: string): AgentOrchestrator | undefined;
  setSessionContext(sessionId: string, messages: Message[]): void;
  setWorkingDirectory(sessionId: string, directory: string): void;
  /** TaskManager 的 state_change：会话回到 idle 是延后唤醒的投递信号之一（不另起轮询） */
  on(event: 'state_change', listener: (event: { sessionId: string; data?: unknown }) => void): unknown;
  /** RunRegistry 有 run 退场（前台轮结束）：延后唤醒的另一个投递信号，web 入口的轮不经 state_change */
  onRunIdle(listener: () => void): unknown;
}

interface WakeLogger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
}

export interface ForegroundWakeDependencies {
  getTaskManager(): WakeTaskManager;
  loadSession(sessionId: string): Promise<SessionWithMessages | null>;
  hasQueuedUserInput(sessionId: string): boolean;
  isVoiceSession(sessionId: string): boolean;
  /** 唤醒轮失败时给用户的一句人话（任务结果本身已由 projectTerminalResult 落在会话里） */
  recordWakeFailureNote(
    sessionId: string,
    content: string,
    detail: { taskId: string; reason: 'owner_missing' | 'wake_failed' },
  ): Promise<void>;
  logger: WakeLogger;
}

interface ConsecutiveWakeState {
  lastVisibleUserMessageId: string | null;
  count: number;
}

const logger = createLogger('ForegroundWake');

function hasQueuedUserInput(sessionId: string): boolean {
  try {
    const db = getDatabase().getDb();
    if (!db) {
      logger.warn('Foreground wake skipped: queued-input database unavailable', { sessionId });
      return true;
    }
    const repository = new QueuedInputRepository(db);
    return repository.listBySession(sessionId, 'queued').length > 0
      || repository.listBySession(sessionId, 'sending').length > 0;
  } catch (error) {
    logger.warn('Foreground wake skipped: queued-input state unavailable', {
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

const defaultDependencies: ForegroundWakeDependencies = {
  getTaskManager,
  loadSession: (sessionId) => getSessionManager().getSession(sessionId, Number.MAX_SAFE_INTEGER),
  hasQueuedUserInput,
  isVoiceSession: (sessionId) => getPermissionModeManager().isLiveVoiceSession(sessionId),
  recordWakeFailureNote: async (sessionId, content, detail) => {
    // 必须带登记键：渲染端按 systemEventRegistry 放行，无 metadata 的 system 消息一律被投影层跳过
    const message: Message = {
      id: `session-wake-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      content,
      timestamp: Date.now(),
      metadata: { backgroundWakeFailed: detail } satisfies SystemEventMessageMetadata,
    };
    await getSessionManager().addMessageToSession(sessionId, message);
    // 在线会话立即可见（该 system 'message' 事件只广播、不会被 TaskManager 二次落库）
    getTaskManager().emitAgentEventForSession(sessionId, { type: 'message', data: message });
  },
  logger,
};

function latestVisibleUserMessageId(messages: Message[]): string | null {
  return [...messages]
    .reverse()
    .find((message) => message.role === 'user' && !message.isMeta)
    ?.id ?? null;
}

function wakePrompt(task: SessionCommandTask, status: Extract<WakeStatus, 'completed' | 'failed'>): string {
  const outcome = status === 'completed' ? '完成' : '失败';
  // 用户绕过团长直接给这个任务补过话（N-SUBAGENT-INPUT）：收工汇总要知道，免得漏掉用户改过的要求
  const supplement = task.userInputCount ? `期间用户直接给它补了 ${task.userInputCount} 句。` : '';
  // resultText 优先：240 字 summary 会截断「改走 Bash curl 审批」这类可执行提示（FB-577）
  const resultText = task.resultText ?? task.summary ?? task.detail ?? '无摘要';
  return `后台任务 ${task.shortName} 已${outcome}，结果摘要：${resultText}。${supplement}`;
}

export function createForegroundWake(
  dependencies: ForegroundWakeDependencies = defaultDependencies,
): (task: SessionCommandTask, status: WakeStatus) => Promise<void> {
  const consecutiveBySession = new Map<string, ConsecutiveWakeState>();
  const inFlightSessions = new Set<string>();
  // 每会话只记最新一次被推迟的唤醒；会话回到 idle（或在途唤醒结束）时投递一次
  const pendingBySession = new Map<string, { task: SessionCommandTask; status: WakeStatus }>();
  let idleListenerInstalled = false;

  const defer = (
    manager: WakeTaskManager,
    task: SessionCommandTask,
    status: WakeStatus,
    reason: string,
    details?: Record<string, unknown>,
  ): void => {
    pendingBySession.set(task.sessionId, { task, status });
    dependencies.logger.info(`Foreground wake deferred: ${reason}`, {
      sessionId: task.sessionId,
      taskId: task.id,
      ...details,
    });
    if (idleListenerInstalled) return;
    idleListenerInstalled = true;
    manager.on('state_change', (event) => {
      if ((event.data as { status?: unknown } | undefined)?.status !== 'idle') return;
      flushPending(event.sessionId);
    });
    manager.onRunIdle(() => {
      for (const sessionId of [...pendingBySession.keys()]) {
        if (manager.hasActivePrimaryRun(sessionId)) continue;
        // 退场通知发生在 orchestrator 清 agentLoop 之前的同一同步段，放到微任务再检查 isProcessing
        queueMicrotask(() => flushPending(sessionId));
      }
    });
  };

  const flushPending = (sessionId: string): void => {
    const pending = pendingBySession.get(sessionId);
    if (!pending || inFlightSessions.has(sessionId)) return;
    pendingBySession.delete(sessionId);
    void wake(pending.task, pending.status).catch((error) => {
      dependencies.logger.warn('Foreground wake failed', {
        sessionId,
        taskId: pending.task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const wake = async (task: SessionCommandTask, status: WakeStatus): Promise<void> => {
    const sessionId = task.sessionId;
    if (status === 'cancelled') {
      dependencies.logger.info('Foreground wake skipped: task cancelled', { sessionId, taskId: task.id });
      return;
    }
    if (inFlightSessions.has(sessionId)) {
      // 在途唤醒结束后补投，别丢第二个任务的结果
      pendingBySession.set(sessionId, { task, status });
      dependencies.logger.info('Foreground wake deferred: wake already in flight', { sessionId, taskId: task.id });
      return;
    }

    inFlightSessions.add(sessionId);
    let turnRan = false;
    try {
      const session = await dependencies.loadSession(sessionId);
      if (!session || (session.type ?? 'chat') !== 'chat') {
        dependencies.logger.info('Foreground wake skipped: not a text chat session', {
          sessionId,
          taskId: task.id,
          sessionType: session?.type,
        });
        return;
      }
      if (dependencies.isVoiceSession(sessionId)) {
        dependencies.logger.info('Foreground wake skipped: voice session', { sessionId, taskId: task.id });
        return;
      }

      const manager = dependencies.getTaskManager();
      const state = manager.getSessionState(sessionId);
      if (
        state.status !== 'idle'
        || manager.hasActivePrimaryRun(sessionId)
        || manager.getWaitingQueue().includes(sessionId)
      ) {
        defer(manager, task, status, 'session busy', { status: state.status });
        return;
      }
      if (dependencies.hasQueuedUserInput(sessionId)) {
        defer(manager, task, status, 'queued user input');
        return;
      }

      const visibleUserMessageId = latestVisibleUserMessageId(session.messages);
      const previous = consecutiveBySession.get(sessionId);
      const consecutive = previous?.lastVisibleUserMessageId === visibleUserMessageId
        ? previous.count
        : 0;
      if (consecutive >= MAX_CONSECUTIVE_WAKES) {
        dependencies.logger.warn('Foreground wake skipped: consecutive wake limit reached', {
          sessionId,
          taskId: task.id,
          consecutive,
          limit: MAX_CONSECUTIVE_WAKES,
        });
        return;
      }

      const orchestrator = manager.getOrCreateCurrentOrchestrator(sessionId);
      if (!orchestrator) {
        dependencies.logger.info('Foreground wake skipped: no resident foreground orchestrator', {
          sessionId,
          taskId: task.id,
        });
        return;
      }
      if (orchestrator.isProcessing()) {
        defer(manager, task, status, 'foreground orchestrator processing');
        return;
      }

      manager.setSessionContext(sessionId, session.messages);
      if (session.workingDirectory) manager.setWorkingDirectory(sessionId, session.workingDirectory);

      const brainOptions = withSessionCommandCenterBrain({
        mode: 'normal',
        inputHistoryVisibility: 'meta',
        runRegistration: 'auxiliary',
        maxIterations: SESSION_COMMAND_CENTER_WAKE_MAX_ITERATIONS,
        turnSystemContext: [FOREGROUND_WAKE_CONTRACT],
      });
      const options = {
        ...brainOptions,
        mode: 'normal',
        inputHistoryVisibility: 'meta',
        runRegistration: 'auxiliary',
        maxIterations: SESSION_COMMAND_CENTER_WAKE_MAX_ITERATIONS,
        allowedToolNames: Array.from(new Set([
          ...(brainOptions.allowedToolNames ?? []),
          WAKE_NOOP_TOOL_NAME,
        ])),
      } satisfies AgentRunOptions;

      consecutiveBySession.set(sessionId, {
        lastVisibleUserMessageId: visibleUserMessageId,
        count: consecutive + 1,
      });
      dependencies.logger.info('Foreground wake starting', {
        sessionId,
        taskId: task.id,
        status,
        consecutive: consecutive + 1,
      });
      turnRan = true;
      try {
        await orchestrator.sendMessage(wakePrompt(task, status), undefined, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 失败原因分开记：owner lease 缺失是 run 注册问题，其余是唤醒轮自身失败
        const ownerMissing = message.includes('no live owner lease');
        dependencies.logger.warn(
          `Foreground wake failed: ${ownerMissing ? 'owner missing' : 'wake turn failed'}`,
          { sessionId, taskId: task.id, message },
        );
        await dependencies.recordWakeFailureNote(
          sessionId,
          `后台任务「${task.shortName}」已结束，结果见上方的任务结果；自动汇报这一步没能完成，需要的话可以直接问我。`,
          { taskId: task.id, reason: ownerMissing ? 'owner_missing' : 'wake_failed' },
        ).catch((noteError) => {
          dependencies.logger.warn('Foreground wake failure note not recorded', {
            sessionId,
            taskId: task.id,
            message: noteError instanceof Error ? noteError.message : String(noteError),
          });
        });
      }
    } finally {
      inFlightSessions.delete(sessionId);
      // 只有真跑过唤醒轮才补投在途期间攒下的那次；推迟/跳过的路径补投会自旋
      if (turnRan) flushPending(sessionId);
    }
  };
  return wake;
}

