// ============================================================================
// Interrupted run marker — headless `neo run` 在任何 assistant 回复前被信号打断
// ============================================================================
// 会话行在开跑时已经落库。SIGKILL 来不及写；SIGTERM/SIGINT 可以补一条空 assistant，
// 让重开后的错误卡显示「已中断」而不是一个点了没反应的空会话。

import { createLogger } from '../host/services/infra/logger';
import type { Message } from '../shared/contract';
import { generateMessageId } from '../shared/utils/id';

const logger = createLogger('InterruptedRun');

const RAW_MESSAGE = 'run interrupted by signal';

interface InterruptedRunSessionManager {
  getSession(
    sessionId: string,
    messageLimit?: number,
  ): Promise<{ messages?: ReadonlyArray<{ role?: string }> } | null>;
  addMessageToSession(sessionId: string, message: Message): Promise<void>;
}

interface InterruptSignals {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
}

export interface InstallInterruptHandlersDeps {
  sessionManager: InterruptedRunSessionManager;
  getSessionId: () => string | null;
  now: () => number;
  exit: (code: number) => void;
  /** 命令入口传入的落库函数。缺省用本模块实现。 */
  markInterrupted?: (
    sessionManager: InterruptedRunSessionManager,
    sessionId: string,
    now: number,
  ) => Promise<void>;
  signals?: InterruptSignals;
}

/** 同一进程内重复到达的信号只落一条。 */
let pendingMark: Promise<void> | null = null;

function logMarkFailure(error: unknown): void {
  try {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error('Failed to mark interrupted run', { detail });
  } catch {
    // 记日志失败也不能挡住退出。
  }
}

async function persistInterruptedIfNeeded(
  sessionManager: InterruptedRunSessionManager,
  sessionId: string,
  now: number,
): Promise<void> {
  try {
    const session = await sessionManager.getSession(sessionId, Number.MAX_SAFE_INTEGER);
    const messages = session?.messages ?? [];
    if (messages.some((message) => message.role === 'assistant')) return;

    const message: Message = {
      id: generateMessageId(),
      role: 'assistant',
      content: '',
      timestamp: now,
      metadata: {
        agentError: {
          category: 'interrupted',
          code: 'RUN_INTERRUPTED',
          rawMessage: RAW_MESSAGE,
          timestamp: now,
        },
      },
    };
    await sessionManager.addMessageToSession(sessionId, message);
  } catch (error) {
    logMarkFailure(error);
  }
}

export function markInterruptedIfNoAssistant(
  sessionManager: InterruptedRunSessionManager,
  sessionId: string,
  now: number,
): Promise<void> {
  if (pendingMark) return pendingMark;
  pendingMark = persistInterruptedIfNeeded(sessionManager, sessionId, now);
  return pendingMark;
}

const SIGNAL_EXITS = [
  ['SIGTERM', 143],
  ['SIGINT', 130],
] as const;

export function installInterruptHandlers(deps: InstallInterruptHandlersDeps): () => void {
  const signals: InterruptSignals = deps.signals ?? {
    once: (signal, listener) => {
      process.once(signal, listener);
    },
    off: (signal, listener) => {
      process.off(signal, listener);
    },
  };
  const installed: Array<{ signal: 'SIGTERM' | 'SIGINT'; listener: () => void }> = [];

  for (const [signal, code] of SIGNAL_EXITS) {
    const listener = () => {
      let marking = Promise.resolve();
      try {
        const sessionId = deps.getSessionId();
        const mark = deps.markInterrupted ?? markInterruptedIfNoAssistant;
        if (sessionId) {
          marking = mark(deps.sessionManager, sessionId, deps.now());
        }
      } catch (error) {
        logMarkFailure(error);
      }
      void marking.finally(() => {
        deps.exit(code);
      });
    };
    signals.once(signal, listener);
    installed.push({ signal, listener });
  }

  return () => {
    for (const { signal, listener } of installed) {
      signals.off(signal, listener);
    }
  };
}
