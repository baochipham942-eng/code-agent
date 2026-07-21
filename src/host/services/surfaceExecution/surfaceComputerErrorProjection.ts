import type { ComputerUseStateErrorKindV1 } from '../../../shared/contract/desktop';
import type {
  SurfaceExecutionErrorV1,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import type { SurfaceRuntimeIdentityV1 } from './SurfaceExecutionRuntime';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';

export interface SurfaceComputerErrorInputV1 {
  identity: SurfaceRuntimeIdentityV1;
  provider?: string;
  operationId: string;
  kind: ComputerUseStateErrorKindV1;
  message: string;
  target?: SurfaceTargetRefV1;
}

const COMPUTER_ERROR_CODES: Record<ComputerUseStateErrorKindV1, SurfaceExecutionErrorV1['code']> = {
  invalid_request: 'SURFACE_POLICY_BLOCKED',
  stale_state: 'SURFACE_STATE_STALE',
  state_conflict: 'SURFACE_TARGET_REVISION_CHANGED',
  provider_restarted: 'SURFACE_STATE_STALE',
  target_missing: 'SURFACE_TARGET_NOT_OWNED',
  delivery_unknown: 'SURFACE_DELIVERY_UNKNOWN',
  verification_failed: 'SURFACE_POSTCONDITION_FAILED',
  provider_error: 'SURFACE_TRANSPORT_UNAVAILABLE',
};

export function projectSurfaceComputerError(
  input: SurfaceComputerErrorInputV1,
  sessionId: string,
): SurfaceExecutionErrorV1 {
  return new SurfaceExecutionRuntimeError({
    code: COMPUTER_ERROR_CODES[input.kind],
    message: input.message,
    phase: input.kind === 'verification_failed' ? 'verify' : 'act',
    retryable: input.kind !== 'invalid_request',
    userActionRequired: input.kind === 'target_missing',
    recommendedAction: input.kind === 'delivery_unknown'
      ? 'Inspect the successor state before deciding whether to retry.'
      : 'Capture a fresh observation before retrying.',
    surface: 'computer',
    provider: input.provider || 'cua-driver',
    sessionId,
    ...(input.target ? { targetRef: input.target } : {}),
    operationId: input.operationId,
  }).surfaceError;
}
