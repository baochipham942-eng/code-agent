import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';

function isSessionTurnActive(input: {
  processing: boolean;
  running: boolean;
  taskStatus?: string | null;
}): boolean {
  return input.processing
    || input.running
    || input.taskStatus === 'running'
    || input.taskStatus === 'queued'
    || input.taskStatus === 'cancelling';
}

/** Same live-turn truth consumed by reply actions, sidebar status, and artifact follow UI. */
export function useSessionTurnActive(sessionId: string | null | undefined): boolean {
  const processing = useAppStore((state) => (
    sessionId ? state.processingSessionIds?.has(sessionId) ?? false : false
  ));
  const running = useSessionStore((state) => (
    sessionId ? state.runningSessionIds?.has(sessionId) ?? false : false
  ));
  const taskStatus = useTaskStore((state) => (
    sessionId ? state.sessionStates?.[sessionId]?.status : undefined
  ));
  return isSessionTurnActive({ processing, running, taskStatus });
}
