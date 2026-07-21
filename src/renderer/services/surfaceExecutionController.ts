import type { SurfaceSessionControlRequestV1 } from '@shared/contract/surfaceExecution';
import type { SurfaceExecutionControlIntentV1 } from '../components/features/surfaceExecution';
import { useSurfaceExecutionStore } from '../stores/surfaceExecutionStore';
import { surfaceExecutionScopeKeyV1 } from '../utils/surfaceExecutionProjection';
import { controlSurfaceExecutionSession } from './surfaceExecutionClient';

export interface SurfaceExecutionControlDependencies {
  control: typeof controlSurfaceExecutionSession;
  now: () => number;
  requestId: () => string;
}

const defaultDependencies: SurfaceExecutionControlDependencies = {
  control: controlSurfaceExecutionSession,
  now: Date.now,
  requestId: () => globalThis.crypto?.randomUUID?.()
    ?? `surface-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function executeSurfaceExecutionControl(
  intent: SurfaceExecutionControlIntentV1,
  dependencies: SurfaceExecutionControlDependencies = defaultDependencies,
): Promise<void> {
  const initial = useSurfaceExecutionStore.getState();
  const sessions = initial.getSessions({
    conversationId: intent.conversationId,
    surfaceSessionId: intent.surfaceSessionId,
  });
  if (sessions.length !== 1) throw new Error('Surface session identity is unavailable or ambiguous');

  const session = sessions[0];
  const durableContinuation = intent.action === 'continue'
    && session.source === 'persisted'
    && !session.writable;
  if ((!session.writable && !durableContinuation) || session.source === 'compat') {
    throw new Error('Compatibility Surface sessions are read-only');
  }
  if (!session.availableControls.includes(intent.action)) {
    throw new Error('Surface control is no longer available');
  }

  const scope = session.scope;
  const scopeKey = surfaceExecutionScopeKeyV1(scope);
  const activeControl = initial.controlByScope[scopeKey];
  if (activeControl?.status === 'pending') {
    throw new Error('A Surface control request is already pending');
  }

  const requestId = dependencies.requestId();
  const startedAt = dependencies.now();
  initial.setControlRequestState(scope, {
    action: intent.action,
    status: 'pending',
    requestId,
    startedAt,
  });

  const request: SurfaceSessionControlRequestV1 = { ...intent };
  try {
    const result = await dependencies.control(request);
    useSurfaceExecutionStore.getState().setNativeSnapshot(intent.conversationId, result.snapshot);
    const current = useSurfaceExecutionStore.getState();
    if (current.controlByScope[scopeKey]?.requestId === requestId) {
      current.setControlRequestState(scope, {
        action: intent.action,
        status: 'succeeded',
        requestId,
        startedAt,
        settledAt: dependencies.now(),
      });
    }
  } catch (error) {
    const current = useSurfaceExecutionStore.getState();
    if (current.controlByScope[scopeKey]?.requestId === requestId) {
      current.setControlRequestState(scope, {
        action: intent.action,
        status: 'failed',
        requestId,
        startedAt,
        settledAt: dependencies.now(),
        error: errorMessage(error),
      });
    }
    throw error;
  }
}
