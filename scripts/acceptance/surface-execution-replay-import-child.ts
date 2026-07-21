import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTranscriptReplay } from '../../src/host/evaluation/transcriptReplayBuilder.ts';
import { initDatabase } from '../../src/host/services/core/databaseService.ts';
import {
  getSessionManager,
  type SessionWithMessages,
} from '../../src/host/services/infra/sessionManager.ts';
import {
  SurfaceConversationProjectionService,
} from '../../src/host/services/surfaceExecution/SurfaceConversationProjectionService.ts';
import type {
  SurfaceConversationSnapshotV1,
  SurfaceSessionControlResultV1,
} from '../../src/shared/contract/surfaceExecution.ts';
import type {
  ReplayBlock,
  StructuredReplay,
  TelemetryCompleteness,
} from '../../src/shared/contract/evaluation.ts';
import {
  collectSurfaceExecutionExportProjection,
  parseSurfaceExecutionExportProjectionV1,
  type SurfaceExecutionExportProjectionV1,
} from '../../src/shared/utils/surfaceExecutionExportProjection.ts';
import { parseArgs, requireStringOption } from './_helpers.ts';

const RAW_CANARY_PATTERN = /surface-secret-canary-[a-z0-9._:-]+/i;

const RAW_SURFACE_FIELD_KEYS = new Set([
  'accessGrant',
  'activeTarget',
  'assetRef',
  'base64Image',
  'browserInstanceId',
  'bytes',
  'cookie',
  'cookies',
  'documentRevision',
  'elementRef',
  'grantId',
  'grantRef',
  'imageBase64',
  'imageData',
  'imageDataUrl',
  'imagePath',
  'outputPath',
  'path',
  'profileDir',
  'profilePath',
  'screenshotBase64',
  'screenshotData',
  'screenshotPath',
  'storageState',
  'tabRef',
  'target',
  'targetRef',
  'userDataDir',
  'windowRef',
]);

interface SemanticEvidenceV1 {
  kind: string;
  source: string;
  title: string;
  captureState: string;
  analysisState: string;
  verificationState: string;
}

export interface SurfaceReplaySemanticEventV1 {
  surface: string;
  phase: string;
  status: string;
  userSummary: string;
  operationAction: string | null;
  operationRisk: string | null;
  observationVerdict: string | null;
  observationFindings: string[];
  evidence: SemanticEvidenceV1[];
  actionDelivery: string | null;
  actionVerification: string | null;
  actionOverall: string | null;
}

interface ReplayImportChildResultV1 {
  version: 1;
  status: 'passed';
  pid: number;
  identifiers: {
    sourceSessionIdSha256: string;
    importedSessionIdSha256: string;
  };
  semantics: {
    sourceSha256: string;
    replaySha256: string;
    sourceEventCount: number;
    replayEventCount: number;
  };
  assertions: {
    importedIntoIsolatedStore: boolean;
    conversationRebound: boolean;
    archiveProjectionReadOnly: boolean;
    grantNone: boolean;
    noTarget: boolean;
    noControls: boolean;
    runtimeMutationCallsZero: boolean;
    replayExplicitSurfaceEvents: boolean;
    failureAdjustPassReproduced: boolean;
    semanticDigestMatched: boolean;
    rawCanaryAbsent: boolean;
    portableScreenshotEvidenceMetadataOnly: boolean;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function surfaceReplaySemanticDigest(
  events: readonly SurfaceReplaySemanticEventV1[],
): string {
  return sha256(JSON.stringify(canonicalize(events)));
}

function semanticEvidence(value: unknown): SemanticEvidenceV1 | null {
  if (!isRecord(value)) return null;
  const kind = typeof value.kind === 'string' ? value.kind : null;
  const source = typeof value.source === 'string' ? value.source : null;
  const title = typeof value.title === 'string' ? value.title : null;
  const captureState = typeof value.captureState === 'string' ? value.captureState : null;
  const analysisState = typeof value.analysisState === 'string' ? value.analysisState : null;
  const verificationState = typeof value.verificationState === 'string'
    ? value.verificationState
    : null;
  if (!kind || !source || !title || !captureState || !analysisState || !verificationState) {
    return null;
  }
  return { kind, source, title, captureState, analysisState, verificationState };
}

function semanticEvent(input: {
  surface: unknown;
  phase: unknown;
  status: unknown;
  userSummary: unknown;
  operation: unknown;
  observation: unknown;
  evidence: unknown;
  actionResult: unknown;
}): SurfaceReplaySemanticEventV1 | null {
  if (
    typeof input.surface !== 'string'
    || typeof input.phase !== 'string'
    || typeof input.status !== 'string'
    || typeof input.userSummary !== 'string'
  ) return null;
  const operation = isRecord(input.operation) ? input.operation : null;
  const observation = isRecord(input.observation) ? input.observation : null;
  const actionResult = isRecord(input.actionResult) ? input.actionResult : null;
  return {
    surface: input.surface,
    phase: input.phase,
    status: input.status,
    userSummary: input.userSummary,
    operationAction: typeof operation?.action === 'string' ? operation.action : null,
    operationRisk: typeof operation?.risk === 'string' ? operation.risk : null,
    observationVerdict: typeof observation?.verdict === 'string' ? observation.verdict : null,
    observationFindings: Array.isArray(observation?.findings)
      ? observation.findings.filter((finding): finding is string => typeof finding === 'string')
      : [],
    evidence: Array.isArray(input.evidence)
      ? input.evidence.map(semanticEvidence).filter((item): item is SemanticEvidenceV1 => Boolean(item))
      : [],
    actionDelivery: typeof actionResult?.delivery === 'string' ? actionResult.delivery : null,
    actionVerification: typeof actionResult?.verification === 'string'
      ? actionResult.verification
      : null,
    actionOverall: typeof actionResult?.overall === 'string' ? actionResult.overall : null,
  };
}

export function surfaceReplaySemanticsFromProjection(
  projection: SurfaceExecutionExportProjectionV1,
): SurfaceReplaySemanticEventV1[] {
  return projection.sessions.flatMap((session) => session.events.map((event) => (
    semanticEvent({
      surface: session.surface,
      phase: event.phase,
      status: event.status,
      userSummary: event.userSummary,
      operation: event.operation,
      observation: event.observation,
      evidence: event.evidence,
      actionResult: event.actionResult,
    })
  ))).filter((event): event is SurfaceReplaySemanticEventV1 => Boolean(event));
}

function surfaceArchiveBlocks(replay: StructuredReplay): ReplayBlock[] {
  return replay.turns.flatMap((turn) => turn.blocks).filter((block) => (
    block.type === 'event' && block.event?.eventType === 'surface_execution_archive'
  ));
}

export function surfaceReplaySemanticsFromReplay(
  replay: StructuredReplay,
): SurfaceReplaySemanticEventV1[] {
  return surfaceArchiveBlocks(replay).map((block) => {
    const data = isRecord(block.event?.data) ? block.event.data : {};
    return semanticEvent({
      surface: data.surface,
      phase: data.phase,
      status: data.status,
      userSummary: block.event?.summary ?? block.content,
      operation: data.operation,
      observation: data.observation,
      evidence: data.evidence,
      actionResult: data.actionResult,
    });
  }).filter((event): event is SurfaceReplaySemanticEventV1 => Boolean(event));
}

export function reproducesFailureAdjustPass(
  events: readonly SurfaceReplaySemanticEventV1[],
): boolean {
  const failedVerifyIndex = events.findIndex((event) => (
    event.phase === 'verify'
    && (event.status === 'failed' || event.observationVerdict === 'fail')
  ));
  if (failedVerifyIndex < 0) return false;
  const successfulActIndex = events.findIndex((event, index) => (
    index > failedVerifyIndex && event.phase === 'act' && event.status === 'succeeded'
  ));
  if (successfulActIndex < 0) return false;
  return events.some((event, index) => (
    index > successfulActIndex
    && event.phase === 'verify'
    && event.status === 'succeeded'
    && event.observationVerdict === 'pass'
  ));
}

export function findRawSurfaceFields(value: unknown): string[] {
  const paths: string[] = [];
  const visit = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, child] of Object.entries(candidate)) {
      const childPath = path ? `${path}.${key}` : key;
      if (RAW_SURFACE_FIELD_KEYS.has(key)) paths.push(childPath);
      visit(child, childPath);
    }
  };
  visit(value, '');
  return paths;
}

function sourceExport(value: unknown, sourceSessionId: string): SessionWithMessages {
  assert(isRecord(value), 'Source export must be a JSON object');
  assert(value.id === sourceSessionId, 'Source export session id did not match the requested source');
  assert(Array.isArray(value.messages), 'Source export messages must be an array');
  assert(isRecord(value.metadata), 'Source export must contain session metadata');
  assert(isRecord(value.modelConfig), 'Source export must contain a model configuration');
  return value as unknown as SessionWithMessages;
}

function projectionFromSession(session: SessionWithMessages): SurfaceExecutionExportProjectionV1 {
  const direct = parseSurfaceExecutionExportProjectionV1(
    session.metadata?.surfaceExecutionExportV1,
  );
  assert(direct, 'Source export did not contain a valid Surface export projection');
  const collected = collectSurfaceExecutionExportProjection(session.messages, session.metadata);
  const parsed = parseSurfaceExecutionExportProjectionV1(collected);
  assert(parsed, 'Surface export projection could not be collected through the production parser');
  return parsed;
}

function emptyCompleteness(
  sessionId: string,
  turns: StructuredReplay['turns'],
  toolCallCount: number,
): TelemetryCompleteness {
  return {
    sessionId,
    turnCount: turns.length,
    modelCallCount: 0,
    toolCallCount,
    eventCount: turns.flatMap((turn) => turn.blocks).filter((block) => block.type === 'event').length,
    hasSessionId: true,
    hasModelDecisions: false,
    hasToolSchemas: false,
    hasPermissionTrace: false,
    hasContextCompressionEvents: false,
    hasSubagentTelemetry: false,
    hasRealAgentTrace: false,
    dataSource: 'transcript_fallback',
    source: 'surface_archive_import',
  };
}

function hasScreenshotMetadata(events: readonly SurfaceReplaySemanticEventV1[]): boolean {
  return events.some((event) => event.evidence.some((item) => item.kind === 'screenshot'));
}

function allArchiveAuthorityIsEmpty(snapshot: SurfaceConversationSnapshotV1): boolean {
  return snapshot.sessions.length > 0 && snapshot.sessions.every((projection) => (
    projection.source === 'compat'
    && projection.writable === false
    && projection.availableControls.length === 0
    && projection.grant.state === 'none'
    && projection.grant.capabilities.length === 0
    && projection.grant.actionClasses.length === 0
    && projection.grant.dataScopes.length === 0
    && projection.events.every((event) => event.availableControls.length === 0)
  ));
}

function allConversationIdsRebound(
  snapshot: SurfaceConversationSnapshotV1,
  importedSessionId: string,
  sourceProjection: SurfaceExecutionExportProjectionV1,
): boolean {
  const sourceSurfaceSessionIds = new Set(sourceProjection.sessions.map((session) => session.sessionId));
  return snapshot.conversationId === importedSessionId
    && snapshot.sessions.length === sourceProjection.sessions.length
    && snapshot.sessions.every((projection) => (
      projection.session.conversationId === importedSessionId
      && !sourceSurfaceSessionIds.has(projection.session.sessionId)
      && projection.events.every((event) => (
        event.conversationId === importedSessionId
        && event.sessionId === projection.session.sessionId
      ))
    ));
}

function assertNoRawCanary(...values: unknown[]): void {
  for (const value of values) {
    assert(!RAW_CANARY_PATTERN.test(JSON.stringify(value)), 'Raw redaction canary survived import or replay');
  }
}

function assertAllTrue(assertions: Record<string, boolean>): void {
  const failed = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
  assert(failed.length === 0, `Replay import assertions failed: ${failed.join(', ')}`);
}

export async function runSurfaceExecutionReplayImportChild(input: {
  sourceExportPath: string;
  sourceSessionId: string;
  outputPath: string;
}): Promise<ReplayImportChildResultV1> {
  const dataDir = process.env.CODE_AGENT_DATA_DIR?.trim();
  assert(dataDir, 'CODE_AGENT_DATA_DIR is required for isolated replay import');
  const sourceRaw = JSON.parse(readFileSync(resolve(input.sourceExportPath), 'utf8')) as unknown;
  const source = sourceExport(sourceRaw, input.sourceSessionId);
  const sourceProjection = projectionFromSession(source);
  const sourceSemantics = surfaceReplaySemanticsFromProjection(sourceProjection);
  assert(sourceSemantics.length > 0, 'Source Surface export contained no semantic events');
  assert(reproducesFailureAdjustPass(sourceSemantics), 'Source export did not contain verify-fail, adjust, verify-pass semantics');

  const database = await initDatabase();
  const sessionManager = getSessionManager();
  const sourceWasAbsent = !database.getSession(input.sourceSessionId, { includeDeleted: true });
  let runtimeMutationCalls = 0;
  let service: SurfaceConversationProjectionService | null = null;
  try {
    const importedSessionId = await sessionManager.importSession(source);
    assert(importedSessionId !== input.sourceSessionId, 'Import reused the source conversation id');
    const imported = await sessionManager.getSession(importedSessionId, Number.MAX_SAFE_INTEGER);
    assert(imported, 'Imported conversation was not readable from the production session store');
    const importedProjection = parseSurfaceExecutionExportProjectionV1(
      imported.metadata?.surfaceExecutionExportV1,
    );
    assert(importedProjection, 'Import did not persist a safe Surface export projection');

    const importedSessionPayload = imported;
    const emptyRuntime = {
      snapshotConversation: (conversationId: string): SurfaceConversationSnapshotV1 => ({
        version: 1,
        conversationId,
        sessions: [],
        updatedAt: Date.now(),
      }),
      frames: {
        resolve: async () => {
          throw new Error('Archive replay attempted to resolve a live runtime frame');
        },
      },
      controlConversation: async (): Promise<SurfaceSessionControlResultV1> => {
        runtimeMutationCalls += 1;
        throw new Error('Archive replay attempted a runtime mutation');
      },
      subscribeEvents: () => () => undefined,
    };
    service = new SurfaceConversationProjectionService({
      runtime: emptyRuntime,
      sessionStore: sessionManager,
    });
    const snapshot = await service.getSnapshot(importedSessionId);
    const replay = buildTranscriptReplay(importedSessionId, emptyCompleteness);
    assert(replay, 'Production transcript replay did not reproduce the imported Surface archive');
    const replaySemantics = surfaceReplaySemanticsFromReplay(replay);
    const sourceDigest = surfaceReplaySemanticDigest(sourceSemantics);
    const replayDigest = surfaceReplaySemanticDigest(replaySemantics);
    const archiveBlocks = surfaceArchiveBlocks(replay);
    const rawFields = [
      ...findRawSurfaceFields(importedSessionPayload),
      ...findRawSurfaceFields(snapshot),
      ...findRawSurfaceFields(replay),
    ];
    const authorityEmpty = allArchiveAuthorityIsEmpty(snapshot);
    const assertions: ReplayImportChildResultV1['assertions'] = {
      importedIntoIsolatedStore: sourceWasAbsent
        && !database.getSession(input.sourceSessionId, { includeDeleted: true })
        && imported.id === importedSessionId
        && existsSync(join(resolve(dataDir), 'code-agent.db')),
      conversationRebound: allConversationIdsRebound(snapshot, importedSessionId, sourceProjection),
      archiveProjectionReadOnly: snapshot.sessions.length > 0
        && snapshot.sessions.every((projection) => projection.source === 'compat' && !projection.writable),
      grantNone: authorityEmpty,
      noTarget: rawFields.every((path) => !/(^|\.)(activeTarget|target|targetRef)(\.|$)/.test(path)),
      noControls: authorityEmpty,
      runtimeMutationCallsZero: runtimeMutationCalls === 0,
      replayExplicitSurfaceEvents: archiveBlocks.length === sourceSemantics.length
        && replaySemantics.length === sourceSemantics.length,
      failureAdjustPassReproduced: reproducesFailureAdjustPass(replaySemantics),
      semanticDigestMatched: sourceDigest === replayDigest,
      rawCanaryAbsent: true,
      portableScreenshotEvidenceMetadataOnly: hasScreenshotMetadata(sourceSemantics)
        && hasScreenshotMetadata(replaySemantics)
        && rawFields.length === 0,
    };
    assertNoRawCanary(importedSessionPayload, snapshot, replay);
    assertAllTrue(assertions);

    const result: ReplayImportChildResultV1 = {
      version: 1,
      status: 'passed',
      pid: process.pid,
      identifiers: {
        sourceSessionIdSha256: sha256(input.sourceSessionId),
        importedSessionIdSha256: sha256(importedSessionId),
      },
      semantics: {
        sourceSha256: sourceDigest,
        replaySha256: replayDigest,
        sourceEventCount: sourceSemantics.length,
        replayEventCount: replaySemantics.length,
      },
      assertions,
    };
    assertNoRawCanary(result);
    const serialized = JSON.stringify(result);
    assert(!serialized.includes(input.sourceSessionId), 'Result leaked the source conversation id');
    assert(!serialized.includes(importedSessionId), 'Result leaked the imported conversation id');
    assert(findRawSurfaceFields(result).length === 0, 'Result leaked raw Surface fields');
    mkdirSync(dirname(resolve(input.outputPath)), { recursive: true });
    writeFileSync(resolve(input.outputPath), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  } finally {
    service?.dispose();
    database.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runSurfaceExecutionReplayImportChild({
    sourceExportPath: requireStringOption(args, 'source-export'),
    sourceSessionId: requireStringOption(args, 'source-session-id'),
    outputPath: requireStringOption(args, 'out'),
  });
  console.log(JSON.stringify({
    ok: true,
    pid: result.pid,
    sourceSemanticSha256: result.semantics.sourceSha256,
    replaySemanticSha256: result.semantics.replaySha256,
  }));
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && entryPath === resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'Error';
    console.error(JSON.stringify({ ok: false, error: `surface_replay_import_failed:${name}` }));
    process.exitCode = 1;
  });
}
