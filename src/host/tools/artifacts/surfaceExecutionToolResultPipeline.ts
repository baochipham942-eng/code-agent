import { basename, isAbsolute, resolve } from 'node:path';
import type { ToolExecutionResult } from '../types';
import type {
  SurfaceEvidenceCardV1,
  SurfaceExecutionEventV1,
} from '../../../shared/contract/surfaceExecution';
import {
  isSurfaceEvidenceCardV1,
  isSurfaceExecutionEventV1,
} from '../../../shared/contract/surfaceExecution';
import { attachSurfaceExecutionResultProjection } from '../../services/surfaceExecution/surfaceExecutionResultProjection';
import { getSurfaceExecutionRuntime } from '../../services/surfaceExecution/SurfaceExecutionRuntime';
import { surfaceProofService } from '../../services/surfaceExecution/SurfaceProofService';
import { finalizeDeferredBrowserActionProof } from '../vision/browserActionFinalize';
import { persistBase64ImageMetadata } from './base64ImageArtifacts';
import { isBrowserScopedComputerUseAction } from '../../../shared/utils/browserComputerActionCatalog';
import { isPathWithinRoot } from '../../runtime/workspaceScope';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function imagePath(value: unknown): string | null {
  return typeof value === 'string'
    && isAbsolute(value)
    && /\.(?:png|jpe?g|webp|gif)$/i.test(value.split(/[?#]/, 1)[0] || value)
    ? value
    : null;
}

function absolutePath(value: unknown): string | null {
  return typeof value === 'string' && isAbsolute(value) ? value : null;
}

function recordString(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] as string : null;
}

interface TrustedOutputCandidate {
  path: string;
  sourceRefs: string[];
  kind: 'artifact' | 'file' | 'download';
  label: string;
  expectedSha256?: string;
  allowedRoot?: string;
}

function withinDirectory(path: string, directory: string): boolean {
  return isPathWithinRoot(resolve(path), resolve(directory));
}

function trustedOutputCandidates(
  result: ToolExecutionResult,
  input: { toolName: string; arguments: Record<string, unknown>; workingDirectory: string },
): TrustedOutputCandidate[] {
  const metadata = result.metadata;
  if (!metadata) return [];
  const candidates: TrustedOutputCandidate[] = [];
  const add = (path: string | null, sourceRefs: Array<string | null>, kind: TrustedOutputCandidate['kind'], label?: string | null, trustedSchema = false, expectedSha256?: string | null) => {
    if (!path || (!trustedSchema && !withinDirectory(path, input.workingDirectory))) return;
    candidates.push({
      path,
      sourceRefs: Array.from(new Set(sourceRefs.filter((ref): ref is string => Boolean(ref)))),
      kind,
      label: label?.trim() || basename(path),
      ...(expectedSha256 ? { expectedSha256: expectedSha256.toLowerCase() } : {}),
      ...(!trustedSchema ? { allowedRoot: input.workingDirectory } : {}),
    });
  };
  add(absolutePath(metadata.outputPath), [], 'file');
  const action = input.arguments.action ?? input.arguments.operation;
  if (action === 'screenshot') add(absolutePath(metadata.path), [], 'artifact');
  if (metadata.imageBase64Persisted === true) {
    add(absolutePath(metadata.imagePath), [recordString(metadata.artifact, 'artifactId')], 'artifact');
  }
  const metadataArtifacts: unknown[] = Array.isArray(metadata.artifacts)
    ? metadata.artifacts as unknown[]
    : [];
  const records: unknown[] = [
    metadata.outputArtifact,
    metadata.artifact,
    ...metadataArtifacts,
  ];
  for (const value of records) {
    if (!isRecord(value)) continue;
    const sourceTool = recordString(value, 'sourceTool');
    const sha256 = recordString(value, 'sha256');
    const trustedSchema = sourceTool === input.toolName && Boolean(sha256 && /^[a-f0-9]{64}$/i.test(sha256));
    if (!trustedSchema) continue;
    add(
      absolutePath(value.path) || absolutePath(value.artifactPath),
      [recordString(value, 'artifactId'), recordString(value, 'id'), recordString(value, 'ref')],
      value.kind === 'download' ? 'download' : 'artifact',
      recordString(value, 'label') || recordString(value, 'title') || recordString(value, 'name'),
      true,
      sha256,
    );
  }
  return Array.from(new Map(candidates.map((candidate) => [candidate.path, candidate])).values());
}

function trustedFramePath(
  result: ToolExecutionResult,
  input: { toolName: string; arguments: Record<string, unknown>; workingDirectory: string },
): string | null {
  const metadata = result.metadata;
  if (!metadata) return null;
  const action = input.arguments.action ?? input.arguments.operation;
  if (input.toolName === 'browser_action' && action === 'screenshot') {
    const path = imagePath(metadata.path);
    if (path) return path;
  }
  if (input.toolName === 'computer_use') {
    const nested = imagePath(recordString(metadata.computerSurfaceSnapshot, 'screenshotPath'));
    if (nested) return nested;
    if (action === 'screenshot') {
      const path = imagePath(metadata.path);
      if (path) return path;
    }
  }
  const persisted = imagePath(metadata.imagePath);
  const artifactRoot = resolve(input.workingDirectory, '.code-agent/artifacts/images');
  if (persisted
    && metadata.imageBase64Persisted === true
    && isPathWithinRoot(resolve(persisted), artifactRoot)) {
    return persisted;
  }
  const artifacts: unknown[] = Array.isArray(metadata.artifacts) ? metadata.artifacts : [];
  for (const value of [metadata.artifact, ...artifacts]) {
    if (!isRecord(value)) continue;
    const path = typeof value.path === 'string' ? value.path : '';
    const mimeType = typeof value.mimeType === 'string' ? value.mimeType : '';
    if (imagePath(path)
      && /^image\/(?:png|jpe?g|webp|gif)$/i.test(mimeType)
      && value.sourceTool === input.toolName
      && typeof value.sha256 === 'string') return path;
  }
  return null;
}

function replaceEventEvidence(
  value: unknown,
  card: SurfaceEvidenceCardV1,
): SurfaceExecutionEventV1 | unknown {
  if (!isSurfaceExecutionEventV1(value)) return value;
  return {
    ...value,
    evidence: (value.evidence || []).map((candidate) => (
      candidate.evidenceId === card.evidenceId ? card : candidate
    )),
  };
}

function attachLiveSurfaceFrame(
  result: ToolExecutionResult,
  input: {
    toolName: string;
    arguments: Record<string, unknown>;
    workingDirectory: string;
    conversationId?: string;
    runId?: string;
    turnId?: string;
    agentId?: string;
  },
): ToolExecutionResult {
  const metadata = result.metadata;
  const framePath = trustedFramePath(result, input);
  const card = metadata?.surfaceEvidenceCardV1;
  if (!metadata
    || !framePath
    || !isSurfaceEvidenceCardV1(card)
    || card.kind !== 'screenshot'
    || card.redactionStatus !== 'clean'
    || card.inspection.captureState !== 'captured'
    || !input.conversationId
    || !input.runId
    || !input.agentId) return result;
  const scope = isRecord(metadata.surfaceProofScopeV1) ? metadata.surfaceProofScopeV1 : null;
  const surfaceSessionId = typeof scope?.surfaceSessionId === 'string'
    ? scope.surfaceSessionId
    : typeof metadata.surfaceSessionId === 'string' ? metadata.surfaceSessionId : null;
  if (!surfaceSessionId) return result;
  const runtime = getSurfaceExecutionRuntime();
  const session = runtime.sessions.get(surfaceSessionId);
  if (session?.conversationId !== input.conversationId
    || session.runId !== input.runId
    || session.agentId !== input.agentId
    || session.surface !== card.source) return result;
  let projected: SurfaceEvidenceCardV1 | undefined;
  try {
    projected = runtime.frames.projectEvidence(
      { sessionId: session.sessionId, runId: session.runId, agentId: session.agentId },
      [{ ...card, assetRef: framePath }],
    )?.[0];
  } catch {
    return result;
  }
  if (!projected?.assetRef?.startsWith('surface-frame://')) return result;
  return {
    ...result,
    metadata: {
      ...metadata,
      surfaceEvidenceCardV1: projected,
      surfaceExecutionEventV1: replaceEventEvidence(metadata.surfaceExecutionEventV1, projected),
      ...(Array.isArray(metadata.surfaceExecutionEventsV1)
        ? { surfaceExecutionEventsV1: metadata.surfaceExecutionEventsV1.map((event) => replaceEventEvidence(event, projected)) }
        : {}),
    },
  };
}

function attachLiveSurfaceOutputs(
  result: ToolExecutionResult,
  input: {
    toolName: string;
    arguments: Record<string, unknown>;
    workingDirectory: string;
    conversationId?: string;
    runId?: string;
    agentId?: string;
  },
): ToolExecutionResult {
  const metadata = result.metadata;
  const candidates = trustedOutputCandidates(result, input);
  if (!metadata || candidates.length === 0
    || !input.conversationId || !input.runId || !input.agentId) return result;
  const scope = isRecord(metadata.surfaceProofScopeV1) ? metadata.surfaceProofScopeV1 : null;
  const surfaceSessionId = typeof scope?.surfaceSessionId === 'string'
    ? scope.surfaceSessionId
    : typeof metadata.surfaceSessionId === 'string' ? metadata.surfaceSessionId : null;
  if (!surfaceSessionId) return result;
  const runtime = getSurfaceExecutionRuntime();
  const session = runtime.sessions.get(surfaceSessionId);
  if (session?.conversationId !== input.conversationId
    || session.runId !== input.runId
    || session.agentId !== input.agentId) return result;
  const subject = { sessionId: session.sessionId, runId: session.runId, agentId: session.agentId };
  const events = Array.isArray(metadata.surfaceExecutionEventsV1)
    ? metadata.surfaceExecutionEventsV1.filter(isSurfaceExecutionEventV1)
    : [];
  const eventRefs = Array.from(new Set(events.flatMap((event) => event.artifactRefs)));
  const replacements = new Map<string, string>();
  const registeredRefs: string[] = [];
  for (const candidate of candidates) {
    const sourceRefs = candidate.sourceRefs.length > 0
      ? candidate.sourceRefs
      : candidates.length === 1 ? eventRefs : [];
    let registered;
    try {
      registered = runtime.outputs.registerLocalOutput({
        subject,
        conversationId: session.conversationId,
        path: candidate.path,
        sourceRefs,
        kind: candidate.kind,
        label: candidate.label,
        ...(candidate.expectedSha256 ? { expectedSha256: candidate.expectedSha256 } : {}),
        ...(candidate.allowedRoot ? { allowedRoot: candidate.allowedRoot } : {}),
      });
    } catch {
      continue;
    }
    if (!registered) continue;
    registeredRefs.push(registered.ref);
    for (const sourceRef of sourceRefs) replacements.set(sourceRef, registered.ref);
  }
  if (registeredRefs.length === 0) return result;
  const replaceRefs = (event: SurfaceExecutionEventV1, append = false): SurfaceExecutionEventV1 => ({
    ...event,
    artifactRefs: runtime.outputs.projectRefs(subject, Array.from(new Set([
      ...event.artifactRefs.map((ref) => replacements.get(ref) || ref),
      ...(append ? registeredRefs : []),
    ]))),
  });
  const projectedEvents = events.map((event, index) => replaceRefs(event, index === events.length - 1));
  const terminal = isSurfaceExecutionEventV1(metadata.surfaceExecutionEventV1)
    ? replaceRefs(metadata.surfaceExecutionEventV1, true)
    : projectedEvents.at(-1);
  return {
    ...result,
    metadata: {
      ...metadata,
      ...(terminal ? { surfaceExecutionEventV1: terminal } : {}),
      ...(projectedEvents.length > 0 ? { surfaceExecutionEventsV1: projectedEvents } : {}),
    },
  };
}

export async function finalizeSurfaceAwareToolResult(input: {
  toolName: string;
  arguments: Record<string, unknown>;
  result: ToolExecutionResult;
  workingDirectory: string;
  conversationId?: string;
  runId?: string;
  turnId?: string;
  agentId?: string;
  toolCallId: string;
  startedAt: number;
}): Promise<ToolExecutionResult> {
  const withArtifacts = await persistBase64ImageMetadata(input.result, {
    sourceTool: input.toolName,
    workingDirectory: input.workingDirectory,
    sessionId: input.conversationId,
  });
  const withProof = input.toolName === 'browser_action'
    ? finalizeDeferredBrowserActionProof(withArtifacts, {
        sessionId: input.conversationId,
        runId: input.runId,
        turnId: input.turnId,
        agentId: input.agentId,
        toolCallId: input.toolCallId,
      })
    : withArtifacts;
  const actionValue = input.arguments.action ?? input.arguments.operation;
  const action = typeof actionValue === 'string' ? actionValue : 'unknown';
  const surfaceToolName = input.toolName === 'browser_action' || input.toolName === 'computer_use'
    ? input.toolName
    : null;
  const surface = input.toolName === 'browser_action'
    || isBrowserScopedComputerUseAction(action, input.arguments)
    ? 'browser' as const
    : 'computer' as const;
  const withSurfaceProof = surfaceToolName
    ? surfaceProofService.finalizeToolResult({
        toolName: surfaceToolName,
        action,
        result: withProof,
        surface,
        identity: {
          conversationId: input.conversationId,
          runId: input.runId,
          turnId: input.turnId,
          agentId: input.agentId,
          operationId: input.toolCallId,
        },
      })
    : withProof;
  const projected = attachSurfaceExecutionResultProjection({
    toolName: input.toolName,
    arguments: input.arguments,
    result: withSurfaceProof,
    conversationId: input.conversationId,
    runId: input.runId,
    turnId: input.turnId,
    agentId: input.agentId,
    toolCallId: input.toolCallId,
    startedAt: input.startedAt,
    completedAt: Date.now(),
  });
  const finalized = surfaceToolName
    ? surfaceProofService.finalizeToolResult({
        toolName: surfaceToolName,
        action,
        result: projected,
        surface,
        identity: {
          conversationId: input.conversationId,
          runId: input.runId,
          turnId: input.turnId,
          agentId: input.agentId,
          operationId: input.toolCallId,
        },
      })
    : projected;
  const withLiveFrame = attachLiveSurfaceFrame(
    surfaceProofService.attachEvidenceToProjectedEvents(finalized), input,
  );
  return attachLiveSurfaceOutputs(withLiveFrame, input);
}
