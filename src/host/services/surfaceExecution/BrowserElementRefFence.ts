import type {
  InteractiveSurfaceSessionV1,
  SurfaceObservationV1,
} from '../../../shared/contract/surfaceExecution';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';

interface BrowserElementRefRequest {
  ref: string | null;
  supplied: Record<string, unknown> | null;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function browserElementRefRequest(value: unknown): BrowserElementRefRequest {
  if (typeof value === 'string') {
    return { ref: value.trim() || null, supplied: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ref: null, supplied: null };
  }
  const supplied = value as Record<string, unknown>;
  return {
    ref: optionalString(supplied.refId) || optionalString(supplied.ref) || null,
    supplied,
  };
}

function browserElementRefRequests(
  argumentsValue: Record<string, unknown>,
): BrowserElementRefRequest[] {
  const requests: BrowserElementRefRequest[] = [];
  if (argumentsValue.targetRef !== undefined && argumentsValue.targetRef !== null) {
    requests.push(browserElementRefRequest(argumentsValue.targetRef));
  }
  if (argumentsValue.destinationTargetRef !== undefined
    && argumentsValue.destinationTargetRef !== null) {
    requests.push(browserElementRefRequest(argumentsValue.destinationTargetRef));
  }
  if (argumentsValue.elementRef !== undefined && argumentsValue.elementRef !== null) {
    requests.push(browserElementRefRequest(argumentsValue.elementRef));
  }
  if (Array.isArray(argumentsValue.fields)) {
    for (const field of argumentsValue.fields) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) continue;
      const record = field as Record<string, unknown>;
      if (record.elementRef !== undefined && record.elementRef !== null) {
        requests.push(browserElementRefRequest(record.elementRef));
      }
    }
  }
  return requests;
}

export function assertBrowserElementRefsOwned(input: {
  session: InteractiveSurfaceSessionV1;
  observation: SurfaceObservationV1;
  arguments: Record<string, unknown>;
  operationId: string;
}): void {
  const requested = browserElementRefRequests(input.arguments);
  if (requested.length === 0) return;
  const currentRefs = input.observation.elementRefs.filter((element) => (
    element.kind === 'browser-element'
  ));
  for (const request of requested) {
    const owned = request.ref
      ? currentRefs.find((candidate) => candidate.ref === request.ref)
      : undefined;
    if (!owned) {
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_ELEMENT_REF_NOT_FOUND',
        message: 'Browser element reference is missing, stale, or owned by another Surface observation.',
        phase: 'prepare',
        retryable: true,
        recommendedAction: 'Capture a fresh Browser observation and use its Host-issued element reference.',
        surface: 'browser',
        provider: input.session.provider,
        sessionId: input.session.sessionId,
        targetRef: input.observation.target,
        operationId: input.operationId,
      });
    }
    const supplied = request.supplied;
    const suppliedStateId = optionalString(supplied?.stateId);
    const suppliedTabRef = optionalString(supplied?.tabRef) || optionalString(supplied?.tabId);
    const suppliedDocumentRevision = optionalString(supplied?.documentRevision);
    const suppliedFrameRef = optionalString(supplied?.frameRef) || optionalString(supplied?.frameId);
    const revisionMismatch = (suppliedStateId && suppliedStateId !== input.observation.stateId)
      || (suppliedTabRef && suppliedTabRef !== owned.tabRef)
      || (suppliedDocumentRevision && suppliedDocumentRevision !== owned.documentRevision)
      || (suppliedFrameRef && suppliedFrameRef !== (owned.frameRef || ''))
      || (Number.isSafeInteger(supplied?.backendNodeId)
        && supplied?.backendNodeId !== owned.backendNodeId);
    if (revisionMismatch) {
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_TARGET_REVISION_CHANGED',
        message: 'Browser element reference does not match the current tab or document revision.',
        phase: 'prepare',
        retryable: true,
        recommendedAction: 'Capture a fresh Browser observation before retrying the mutation.',
        surface: 'browser',
        provider: input.session.provider,
        sessionId: input.session.sessionId,
        targetRef: input.observation.target,
        operationId: input.operationId,
      });
    }
  }
}
