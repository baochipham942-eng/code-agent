import type { EvidenceRef } from '../contract/evidence';
import type {
  SurfaceExecutionEventV1,
  SurfaceKind,
  SurfaceTargetRefV1,
} from '../contract/surfaceExecution';
import {
  getStrictBrowserComputerActionCatalogEntry,
  isBrowserScopedComputerUseAction,
} from './browserComputerActionCatalog';
import { sanitizeBrowserComputerToolResult } from './browserComputerRedaction';
import { sanitizeSurfaceExecutionEventV1 } from './surfaceExecutionRedaction';

interface LegacySurfaceResultLike {
  success?: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectLegacySurfaceEventInput {
  eventId: string;
  sequence: number;
  sessionId: string;
  runId: string;
  turnId?: string;
  agentId: string;
  toolName: 'browser_action' | 'computer_use';
  arguments: Record<string, unknown>;
  result: LegacySurfaceResultLike;
  target?: SurfaceTargetRefV1;
  startedAt: number;
  completedAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asEvidenceRefs(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  const proof = isRecord(metadata.browserComputerProof) ? metadata.browserComputerProof : null;
  const refs = proof && Array.isArray(proof.evidenceRefs) ? proof.evidenceRefs : [];
  return refs
    .map((ref) => isRecord(ref) ? ref as Partial<EvidenceRef> : null)
    .map((ref) => typeof ref?.id === 'string' ? ref.id : null)
    .filter((id): id is string => Boolean(id));
}

function asArtifactRefs(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  const artifacts: unknown[] = Array.isArray(metadata.artifacts)
    ? metadata.artifacts as unknown[]
    : [];
  const values: unknown[] = [
    metadata.browserArtifact,
    metadata.outputArtifact,
    metadata.artifactRef,
    metadata.artifact,
    ...artifacts,
  ];
  const refs: string[] = [];
  for (const value of values) {
    if (typeof value === 'string') refs.push(value);
    if (isRecord(value)) {
      const ref = value.artifactId ?? value.id ?? value.path ?? value.ref;
      if (typeof ref === 'string') refs.push(ref);
    }
  }
  return refs;
}

function resolveSurface(
  toolName: ProjectLegacySurfaceEventInput['toolName'],
  action: string,
  args: Record<string, unknown>,
): SurfaceKind {
  if (toolName === 'browser_action') return 'browser';
  return isBrowserScopedComputerUseAction(action, args) ? 'browser' : 'computer';
}

function resolveStatus(result: LegacySurfaceResultLike): SurfaceExecutionEventV1['status'] {
  const overall = result.metadata?.surfaceExecutionActionResultV1
    ?? result.metadata?.surfaceActionResultV1
    ?? result.metadata?.computerUseActionResultV1;
  if (isRecord(overall) && overall.overall === 'ambiguous') return 'ambiguous';
  if (result.metadata?.cancelled === true || result.metadata?.code === 'ABORTED') return 'cancelled';
  return result.success === false ? 'failed' : 'succeeded';
}

function resolveSummary(
  surface: SurfaceKind,
  action: string,
  result: LegacySurfaceResultLike,
): string {
  const label = surface === 'browser' ? '浏览器' : '电脑';
  if (result.success === false) return `${label}操作 ${action} 未完成`;
  return `${label}操作 ${action} 已执行`;
}

export function projectLegacyBrowserComputerResultToSurfaceEventV1(
  input: ProjectLegacySurfaceEventInput,
): SurfaceExecutionEventV1 {
  const safeResult = sanitizeBrowserComputerToolResult(
    input.toolName,
    input.arguments,
    input.result,
  ) || input.result;
  const actionValue = input.arguments.action ?? input.arguments.operation;
  const action = typeof actionValue === 'string' ? actionValue : 'unknown';
  const catalog = getStrictBrowserComputerActionCatalogEntry(input.toolName, action, input.arguments);
  const surface = resolveSurface(input.toolName, action, input.arguments);
  const status = catalog ? resolveStatus(safeResult) : 'failed';
  const observed = isRecord(safeResult.metadata?.browserComputerEvidenceCard)
    ? safeResult.metadata?.browserComputerEvidenceCard
    : null;
  const observationStatus = observed && typeof observed.status === 'string' ? observed.status : null;
  const phase = !catalog
    ? 'recover'
    : observationStatus === 'manual_takeover'
    ? 'human'
    : catalog?.risk === 'read'
      ? 'observe'
      : 'act';
  const event: SurfaceExecutionEventV1 = {
    version: 1,
    eventId: input.eventId,
    sequence: input.sequence,
    sessionId: input.sessionId,
    runId: input.runId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    agentId: input.agentId,
    surface,
    phase,
    status: observationStatus === 'manual_takeover' ? 'waiting' : status,
    userSummary: catalog
      ? resolveSummary(surface, action, safeResult)
      : `Surface capability ${action} is unsupported`,
    ...(input.target ? { target: input.target } : {}),
    operation: {
      action,
      risk: catalog?.risk || 'unsupported',
      approvalScope: catalog?.approvalKind,
    },
    observation: {
      verdict: status === 'succeeded'
        ? observationStatus === 'observed' ? 'pass' : 'not_requested'
        : status === 'failed' ? 'fail' : 'inconclusive',
      findings: observationStatus && typeof observed?.summary === 'string'
        ? [observed.summary]
        : [],
    },
    evidenceRefs: asEvidenceRefs(safeResult.metadata),
    artifactRefs: asArtifactRefs(safeResult.metadata),
    availableControls: status === 'succeeded' || status === 'failed' || status === 'cancelled'
      ? ['end_session']
      : ['pause', 'takeover', 'stop', 'end_session'],
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? Date.now(),
  };
  return sanitizeSurfaceExecutionEventV1(event);
}
