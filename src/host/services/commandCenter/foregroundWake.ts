import type { Message } from '../../../shared/contract';
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
  return `后台任务 ${task.shortName} 已${outcome}，结果摘要：${task.summary ?? task.detail ?? '无摘要'}。`;
}

export function createForegroundWake(
  dependencies: ForegroundWakeDependencies = defaultDependencies,
): (task: SessionCommandTask, status: WakeStatus) => Promise<void> {
  const consecutiveBySession = new Map<string, ConsecutiveWakeState>();
  const inFlightSessions = new Set<string>();

  return async (task, status) => {
    const sessionId = task.sessionId;
    if (status === 'cancelled') {
      dependencies.logger.info('Foreground wake skipped: task cancelled', { sessionId, taskId: task.id });
      return;
    }
    if (inFlightSessions.has(sessionId)) {
      dependencies.logger.info('Foreground wake skipped: wake already in flight', { sessionId, taskId: task.id });
      return;
    }

    inFlightSessions.add(sessionId);
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
        dependencies.logger.info('Foreground wake skipped: session busy', {
          sessionId,
          taskId: task.id,
          status: state.status,
        });
        return;
      }
      if (dependencies.hasQueuedUserInput(sessionId)) {
        dependencies.logger.info('Foreground wake skipped: queued user input', { sessionId, taskId: task.id });
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
        dependencies.logger.info('Foreground wake skipped: foreground orchestrator processing', {
          sessionId,
          taskId: task.id,
        });
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
      await orchestrator.sendMessage(wakePrompt(task, status), undefined, options);
    } finally {
      inFlightSessions.delete(sessionId);
    }
  };
}

