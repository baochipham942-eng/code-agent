import type { InteractiveSurfaceSessionV1 } from '../../../shared/contract/surfaceExecution';
import { BROWSER_HUMAN_TAKEOVER_WAIT } from '../../../shared/constants/timeouts';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';

interface BrowserHumanTakeoverWaitInput {
  readSession: () => InteractiveSurfaceSessionV1;
  operationId: string;
  parentSignal?: AbortSignal;
  now?: () => number;
}

/**
 * Block a browser action while the user is operating the live view.
 * Returns when the session is `running` again. Stopping, any other
 * non-running state, or the wait cap rejects with the same
 * `SURFACE_SESSION_BUSY` error `assertBrowserSessionReady` throws.
 * The run abort signal rejects the wait so a cancelled run cannot sit here
 * until the cap.
 */
export async function waitForBrowserHumanTakeoverRelease(
  input: BrowserHumanTakeoverWaitInput,
): Promise<InteractiveSurfaceSessionV1> {
  const now = input.now ?? Date.now;
  const deadline = now() + BROWSER_HUMAN_TAKEOVER_WAIT.CAP_MS;
  while (true) {
    if (input.parentSignal?.aborted) {
      throw cancelledWhileWaiting(input.readSession(), input.operationId, input.parentSignal.reason);
    }
    const current = input.readSession();
    if (current.state === 'running') {
      forgetCapExpiredWaitingHuman(current.sessionId);
      return current;
    }
    if (current.state !== 'waiting_human') {
      forgetCapExpiredWaitingHuman(current.sessionId);
      throw browserSessionBusy(current, input.operationId);
    }
    if (now() >= deadline || capExpiredWaitingHumanSessions.has(current.sessionId)) {
      rememberCapExpiredWaitingHuman(current.sessionId);
      throw browserSessionBusy(current, input.operationId);
    }
    const remaining = deadline - now();
    try {
      await sleep(Math.min(BROWSER_HUMAN_TAKEOVER_WAIT.POLL_INTERVAL_MS, remaining), input.parentSignal);
    } catch {
      const latest = input.readSession();
      if (input.parentSignal?.aborted) {
        throw cancelledWhileWaiting(latest, input.operationId, input.parentSignal.reason);
      }
      if (latest.state !== 'waiting_human') {
        forgetCapExpiredWaitingHuman(latest.sessionId);
      }
      throw browserSessionBusy(latest, input.operationId);
    }
  }
}

/** FU1-FU2-FU1：waiting_human 的 BUSY 消息面向模型的行动指引（三处 BUSY 站点共用）。 */
export const WAITING_HUMAN_MODEL_GUIDANCE =
  'The user is still using the browser. Do NOT retry browser actions; tell the user to finish and press Continue in the browser window, then stop and wait for their reply.';

/**
 * FU1-FU2-FU1-FU1：同一 session 已等满一次 cap 仍 waiting_human 的记忆。
 * 模型无视 BUSY 指引再次调用时不再各自等满 100s——立即返回同一条 BUSY。
 * 观测到任何非 waiting_human 状态即清除；resume（用户按继续）也主动清除，
 * 新一轮 takeover 重新获得完整的首次等待。插入序上限淘汰防止已消失 session 残留。
 */
const capExpiredWaitingHumanSessions = new Map<string, true>();
const CAP_EXPIRED_WAITING_HUMAN_SESSIONS_MAX = 128;

function rememberCapExpiredWaitingHuman(sessionId: string): void {
  capExpiredWaitingHumanSessions.delete(sessionId);
  capExpiredWaitingHumanSessions.set(sessionId, true);
  while (capExpiredWaitingHumanSessions.size > CAP_EXPIRED_WAITING_HUMAN_SESSIONS_MAX) {
    const oldest = capExpiredWaitingHumanSessions.keys().next();
    if (oldest.done) break;
    capExpiredWaitingHumanSessions.delete(oldest.value);
  }
}

function forgetCapExpiredWaitingHuman(sessionId: string): void {
  capExpiredWaitingHumanSessions.delete(sessionId);
}

/** resume 转换点（SurfaceInterruptService.resume）调用：新一轮接管重新获得完整首次等待。 */
export function forgetBrowserTakeoverCapExpired(sessionId: string): void {
  forgetCapExpiredWaitingHuman(sessionId);
}

function browserSessionBusy(
  session: InteractiveSurfaceSessionV1,
  operationId: string,
): SurfaceExecutionRuntimeError {
  return new SurfaceExecutionRuntimeError({
    code: 'SURFACE_SESSION_BUSY',
    message: `Browser Surface session cannot start an operation while ${session.state}.` + (session.state === 'waiting_human' ? ` ${WAITING_HUMAN_MODEL_GUIDANCE}` : ''),
    phase: 'prepare',
    retryable: session.state === 'paused' || session.state === 'waiting_human',
    userActionRequired: session.state === 'waiting_human',
    recommendedAction: 'Resume or finish human takeover before the next Browser operation.',
    surface: 'browser',
    provider: session.provider,
    sessionId: session.sessionId,
    ...(session.activeTarget ? { targetRef: session.activeTarget } : {}),
    operationId,
  });
}

function cancelledWhileWaiting(
  session: InteractiveSurfaceSessionV1,
  operationId: string,
  reason: unknown,
): SurfaceExecutionRuntimeError {
  return new SurfaceExecutionRuntimeError({
    code: 'SURFACE_REQUEST_CANCELLED',
    message: typeof reason === 'string'
      ? reason
      : 'Browser operation was cancelled while waiting for human takeover to finish.',
    phase: 'prepare',
    retryable: true,
    recommendedAction: 'Re-observe before deciding whether to retry.',
    surface: 'browser',
    provider: session.provider,
    sessionId: session.sessionId,
    ...(session.activeTarget ? { targetRef: session.activeTarget } : {}),
    operationId,
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    function finish(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
