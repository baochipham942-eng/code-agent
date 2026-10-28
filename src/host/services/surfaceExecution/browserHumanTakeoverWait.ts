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
    if (current.state === 'running') return current;
    if (current.state !== 'waiting_human' || now() >= deadline) {
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
      throw browserSessionBusy(latest, input.operationId);
    }
  }
}

function browserSessionBusy(
  session: InteractiveSurfaceSessionV1,
  operationId: string,
): SurfaceExecutionRuntimeError {
  return new SurfaceExecutionRuntimeError({
    code: 'SURFACE_SESSION_BUSY',
    message: `Browser Surface session cannot start an operation while ${session.state}.`,
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
