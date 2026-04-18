import { useMemo } from 'react';
import type { TraceProjection } from '@shared/contract/trace';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSwarmStore } from '../stores/swarmStore';
import { useTaskStore } from '../stores/taskStore';
import { useTurnExecutionClarity } from './useTurnExecutionClarity';
import { useTurnProjection } from './useTurnProjection';

export function useCurrentTurnExecutionProjection(): TraceProjection {
  const { currentSessionId, messages } = useSessionStore();
  const processingSessionIds = useAppStore((state) => state.processingSessionIds);
  const sessionStates = useTaskStore((state) => state.sessionStates);
  const launchRequests = useSwarmStore((state) => state.launchRequests);

  const currentSessionState = currentSessionId ? sessionStates[currentSessionId] : null;
  const effectiveIsProcessing = currentSessionState
    ? currentSessionState.status === 'running' || currentSessionState.status === 'queued'
    : currentSessionId
      ? processingSessionIds.has(currentSessionId)
      : false;

  const baseProjection = useTurnProjection(
    messages,
    currentSessionId,
    effectiveIsProcessing,
    launchRequests,
  );

  const projection = useTurnExecutionClarity(baseProjection);

  return useMemo(() => projection, [projection]);
}
