import type {
  SurfaceExecutionErrorCodeV1,
  SurfaceExecutionErrorV1,
  SurfaceKind,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';

export interface SurfaceExecutionRuntimeErrorInput {
  code: SurfaceExecutionErrorCodeV1;
  message: string;
  phase: SurfaceExecutionErrorV1['phase'];
  retryable?: boolean;
  userActionRequired?: boolean;
  recommendedAction: string;
  surface: SurfaceKind;
  provider: string;
  sessionId: string;
  targetRef?: SurfaceTargetRefV1;
  operationId?: string;
  detailsSafe?: Record<string, unknown>;
}

export class SurfaceExecutionRuntimeError extends Error {
  readonly surfaceError: SurfaceExecutionErrorV1;

  constructor(input: SurfaceExecutionRuntimeErrorInput) {
    super(input.message);
    this.name = 'SurfaceExecutionRuntimeError';
    this.surfaceError = {
      version: 1,
      code: input.code,
      message: input.message,
      phase: input.phase,
      retryable: input.retryable ?? false,
      userActionRequired: input.userActionRequired ?? false,
      recommendedAction: input.recommendedAction,
      surface: input.surface,
      provider: input.provider,
      sessionId: input.sessionId,
      ...(input.targetRef ? { targetRef: input.targetRef } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.detailsSafe ? { detailsSafe: input.detailsSafe } : {}),
    };
  }
}
