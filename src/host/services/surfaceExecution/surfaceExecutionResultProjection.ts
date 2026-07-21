import type { ToolExecutionResult } from '../../tools/types';
import type {
  SurfaceExecutionEventV1,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import { isSurfaceExecutionEventV1 } from '../../../shared/contract/surfaceExecution';
import { projectLegacyBrowserComputerResultToSurfaceEventV1 } from '../../../shared/utils/surfaceExecutionProjection';
import { sanitizeSurfaceExecutionEventV1 } from '../../../shared/utils/surfaceExecutionRedaction';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function surfaceSessionId(metadata: Record<string, unknown>, toolCallId: string): string {
  if (typeof metadata.surfaceSessionId === 'string' && metadata.surfaceSessionId.trim()) {
    return metadata.surfaceSessionId;
  }
  const session = isRecord(metadata.surfaceExecutionSessionV1)
    ? metadata.surfaceExecutionSessionV1
    : null;
  return typeof session?.sessionId === 'string' && session.sessionId.trim()
    ? session.sessionId
    : `legacy-surface:${toolCallId}`;
}

function targetFromMetadata(metadata: Record<string, unknown>): SurfaceTargetRefV1 | undefined {
  const observation = isRecord(metadata.surfaceObservationV1)
    ? metadata.surfaceObservationV1
    : null;
  if (isRecord(observation?.target)) return observation.target as unknown as SurfaceTargetRefV1;
  const session = isRecord(metadata.surfaceExecutionSessionV1)
    ? metadata.surfaceExecutionSessionV1
    : null;
  return isRecord(session?.activeTarget)
    ? session.activeTarget as unknown as SurfaceTargetRefV1
    : undefined;
}

function existingSurfaceEvents(metadata: Record<string, unknown>): SurfaceExecutionEventV1[] {
  const values = Array.isArray(metadata.surfaceExecutionEventsV1)
    ? metadata.surfaceExecutionEventsV1
    : [];
  return values
    .filter(isSurfaceExecutionEventV1)
    .map((event) => sanitizeSurfaceExecutionEventV1(event));
}

function compatibilityComputerModeEvent(input: {
  toolName: string;
  metadata: Record<string, unknown>;
  conversationId: string;
  runId: string;
  agentId: string;
  toolCallId: string;
}): SurfaceExecutionEventV1 | null {
  if (input.toolName !== 'computer_use') return null;
  const value = input.metadata.surfaceExecutionModeEventV1;
  if (!isSurfaceExecutionEventV1(value)) return null;
  const expectedSessionId = `legacy-surface:${input.toolCallId}`;
  if (value.eventId !== `computer-surface-mode:${input.toolCallId}`
    || value.sessionId !== expectedSessionId
    || value.conversationId !== input.conversationId
    || value.runId !== input.runId
    || value.agentId !== input.agentId
    || value.surface !== 'computer'
    || value.provider !== 'computer-surface-compat'
    || value.phase !== 'prepare'
    || value.operation?.action !== 'select_computer_surface_mode') return null;
  return sanitizeSurfaceExecutionEventV1(value);
}

export function attachSurfaceExecutionResultProjection(input: {
  toolName: string;
  arguments: Record<string, unknown>;
  result: ToolExecutionResult;
  conversationId?: string;
  runId?: string;
  turnId?: string;
  agentId?: string;
  toolCallId?: string;
  startedAt: number;
  completedAt: number;
}): ToolExecutionResult {
  if (input.toolName !== 'browser_action' && input.toolName !== 'computer_use') return input.result;
  const conversationId = input.conversationId?.trim();
  const runId = input.runId?.trim();
  const agentId = input.agentId?.trim();
  const toolCallId = input.toolCallId?.trim();
  if (!conversationId || !runId || !agentId || !toolCallId) return input.result;

  const metadata = input.result.metadata || {};
  const existingEvents = existingSurfaceEvents(metadata);
  const modeEvent = existingEvents.length === 0
    ? compatibilityComputerModeEvent({
        toolName: input.toolName,
        metadata,
        conversationId,
        runId,
        agentId,
        toolCallId,
      })
    : null;
  const projected = projectLegacyBrowserComputerResultToSurfaceEventV1({
    eventId: `surface-tool:${toolCallId}`,
    sequence: (existingEvents.at(-1)?.sequence || modeEvent?.sequence || 0) + 1,
    sessionId: surfaceSessionId(metadata, toolCallId),
    runId,
    ...(input.turnId?.trim() ? { turnId: input.turnId.trim() } : {}),
    agentId,
    toolName: input.toolName,
    arguments: input.arguments,
    result: input.result,
    ...(targetFromMetadata(metadata) ? { target: targetFromMetadata(metadata) } : {}),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
  const terminalEvent = existingEvents.length > 0
    ? sanitizeSurfaceExecutionEventV1({
        ...existingEvents[existingEvents.length - 1],
        evidenceRefs: Array.from(new Set([
          ...existingEvents[existingEvents.length - 1].evidenceRefs,
          ...projected.evidenceRefs,
        ])),
        artifactRefs: Array.from(new Set([
          ...existingEvents[existingEvents.length - 1].artifactRefs,
          ...projected.artifactRefs,
        ])),
      })
    : projected;
  const events = existingEvents.length > 0
    ? [...existingEvents.slice(0, -1), terminalEvent]
    : modeEvent ? [modeEvent, terminalEvent] : [terminalEvent];
  return {
    ...input.result,
    metadata: {
      ...metadata,
      surfaceExecutionEventV1: terminalEvent,
      surfaceExecutionEventsV1: events,
      surfaceProjectionMode: existingEvents.length > 0 ? 'native' : 'compatibility',
      conversationId,
    },
  };
}
