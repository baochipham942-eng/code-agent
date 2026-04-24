// useAgentDerived owns memoized values derived from the current session and task maps.
import { useMemo } from 'react';
import { useAppStore } from '../../stores/appStore';

type AppStoreState = ReturnType<typeof useAppStore.getState>;

interface UseAgentDerivedArgs {
  currentSessionId: string | null;
  sessionTaskProgress: AppStoreState['sessionTaskProgress'];
  sessionTaskComplete: AppStoreState['sessionTaskComplete'];
}

export function useAgentDerived({
  currentSessionId,
  sessionTaskProgress,
  sessionTaskComplete,
}: UseAgentDerivedArgs) {
  const taskProgress = currentSessionId
    ? sessionTaskProgress[currentSessionId] ?? null
    : null;
  const lastTaskComplete = currentSessionId
    ? sessionTaskComplete[currentSessionId] ?? null
    : null;

  return useMemo(() => ({
    taskProgress,
    lastTaskComplete,
  }), [taskProgress, lastTaskComplete]);
}
