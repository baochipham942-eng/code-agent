import type { ComputerSurfaceMode } from '../../../shared/contract/desktop';
import type { SurfaceExecutionEventV1 } from '../../../shared/contract/surfaceExecution';
import { sanitizeSurfaceExecutionEventV1 } from '../../../shared/utils/surfaceExecutionRedaction';
import type { ToolExecutionResult } from '../../tools/types';

export interface ComputerSurfaceModeEventIdentity {
  conversationId?: string;
  runId?: string;
  turnId?: string;
  agentId?: string;
  toolCallId?: string;
}

export function createComputerSurfaceModeEvent(input: {
  mode: ComputerSurfaceMode;
  identity: ComputerSurfaceModeEventIdentity;
  occurredAt?: number;
}): SurfaceExecutionEventV1 | null {
  const conversationId = input.identity.conversationId?.trim();
  const runId = input.identity.runId?.trim();
  const agentId = input.identity.agentId?.trim();
  const toolCallId = input.identity.toolCallId?.trim();
  if (!conversationId || !runId || !agentId || !toolCallId) return null;
  const occurredAt = input.occurredAt ?? Date.now();
  const available = input.mode !== 'background_surface_unavailable';
  return sanitizeSurfaceExecutionEventV1({
    version: 1,
    eventId: `computer-surface-mode:${toolCallId}`,
    sequence: 1,
    sessionId: `legacy-surface:${toolCallId}`,
    conversationId,
    runId,
    ...(input.identity.turnId?.trim() ? { turnId: input.identity.turnId.trim() } : {}),
    agentId,
    surface: 'computer',
    provider: 'computer-surface-compat',
    sessionState: available ? 'running' : 'failed',
    phase: 'prepare',
    status: available ? 'succeeded' : 'failed',
    userSummary: computerSurfaceModeSummary(input.mode),
    operation: {
      action: 'select_computer_surface_mode',
      risk: 'input',
      approvalScope: input.mode,
    },
    observation: {
      verdict: available ? 'pass' : 'fail',
      findings: [],
    },
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: available
      ? ['pause', 'takeover', 'stop', 'end_session']
      : ['end_session'],
    startedAt: occurredAt,
    completedAt: occurredAt,
  });
}

export function attachComputerSurfaceModeEvent(
  result: ToolExecutionResult,
  event: SurfaceExecutionEventV1 | null,
): ToolExecutionResult {
  if (!event) return result;
  return {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      surfaceExecutionModeEventV1: sanitizeSurfaceExecutionEventV1(event),
    },
  };
}

function computerSurfaceModeSummary(mode: ComputerSurfaceMode): string {
  if (mode === 'background_ax') return 'Selected background Accessibility input';
  if (mode === 'background_cgevent') return 'Selected background window-local pointer input';
  if (mode === 'foreground_fallback') return 'Selected foreground Computer input fallback';
  return 'Background Computer input is unavailable';
}
