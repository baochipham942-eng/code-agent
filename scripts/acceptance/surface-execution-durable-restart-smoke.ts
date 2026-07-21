import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase } from '../../src/host/services/core/databaseService.ts';
import { getSessionManager } from '../../src/host/services/infra/sessionManager.ts';
import { RunRegistry } from '../../src/host/runtime/runRegistry.ts';
import {
  SURFACE_EXECUTION_LEDGER_METADATA_KEY,
  SurfaceConversationProjectionService,
} from '../../src/host/services/surfaceExecution/SurfaceConversationProjectionService.ts';
import { SurfaceContinuationService } from '../../src/host/services/surfaceExecution/SurfaceContinuationService.ts';
import { SurfaceExecutionRuntime } from '../../src/host/services/surfaceExecution/SurfaceExecutionRuntime.ts';
import type { SurfaceExecutionEventV1 } from '../../src/shared/contract/surfaceExecution.ts';
import {
  finishWithError,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import {
  runSurfaceExecutionP2Acceptance,
  type SurfaceExecutionP2AcceptanceResultV1,
} from './surface-execution-p2-acceptance-core.ts';
import {
  surfaceAcceptanceCampaignProofFields,
  surfaceAcceptanceSourceFingerprint,
} from './surface-execution-proof.ts';
import { assertAcceptanceCanaryAbsent } from './surface-execution-canary-scan.ts';

const PARENT_RUN_ID = 'run-before-process-restart';
const CONTINUATION_RUN_ID = 'run-after-process-restart';
const AGENT_ID = 'durable-agent';
const CANARY = 'surface-secret-canary-durable-restart-e2e';

interface PhaseResultV1 {
  version: 1;
  phase: 'persist' | 'recover';
  pid: number;
  assertions: Record<string, boolean>;
  details: Record<string, unknown>;
}

interface PersistPhaseDetailsV1 {
  conversationId: string;
  surfaceSessionId: string;
  persistentMedia: {
    dataDir: string;
    databasePath: string;
    databaseBytes: number;
    databaseSha256: string;
    recordKey: typeof SURFACE_EXECUTION_LEDGER_METADATA_KEY;
    recordSha256: string;
  };
  sourceExport: {
    path: string;
    sha256: string;
  };
}

interface RecoverPhaseDetailsV1 {
  conversationId: string;
  recoveredSessionId: string;
  continuationSessionId: string;
  parentSessionId?: string;
  persistentMedia: PersistPhaseDetailsV1['persistentMedia'];
  p2Acceptance: SurfaceExecutionP2AcceptanceResultV1;
}

interface ReplayImportResultV1 {
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
  assertions: Record<string, boolean>;
}

function usage(): void {
  console.log(`Surface Execution durable restart acceptance

Usage:
  npm run acceptance:surface-execution-durable -- [options]

Options:
  --out <directory> Persist child-process evidence, proof, and log.
  --json            Print JSON only.
  --help            Show this help.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function durableRecordSha256(value: unknown): string {
  return sha256Text(JSON.stringify(canonicalize(value)));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function acceptanceCommand(): string {
  return ['npm', 'run', 'acceptance:surface-execution-durable', '--', ...process.argv.slice(2)]
    .map(shellQuote)
    .join(' ');
}

function requireDataDir(): string {
  const dataDir = process.env.CODE_AGENT_DATA_DIR?.trim();
  assert(dataDir, 'Durable child phase requires a shared CODE_AGENT_DATA_DIR');
  return resolve(dataDir);
}

function persistentMediaDetails(
  dataDir: string,
  recordSha256: string,
): PersistPhaseDetailsV1['persistentMedia'] {
  const databasePath = join(dataDir, 'code-agent.db');
  assert(existsSync(databasePath), 'Production session database was not created');
  return {
    dataDir,
    databasePath,
    databaseBytes: statSync(databasePath).size,
    databaseSha256: sha256File(databasePath),
    recordKey: SURFACE_EXECUTION_LEDGER_METADATA_KEY,
    recordSha256,
  };
}

async function persistPhase(resultPath: string): Promise<void> {
  const dataDir = requireDataDir();
  const database = await initDatabase();
  const sessionManager = getSessionManager();
  const conversation = await sessionManager.createSession({
    title: 'Surface durable restart acceptance',
    modelConfig: { provider: 'openai', model: 'surface-durable-acceptance' },
    workingDirectory: process.cwd(),
  });
  const conversationId = conversation.id;
  const now = Date.now();
  const registry = new RunRegistry();
  registry.start({ runId: PARENT_RUN_ID, sessionId: conversationId, workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const service = new SurfaceConversationProjectionService({
    runtime,
    sessionStore: sessionManager,
    now: () => now,
  });
  const emittedEvents: SurfaceExecutionEventV1[] = [];
  const identity = {
    conversationId,
    runId: PARENT_RUN_ID,
    agentId: AGENT_ID,
    emitSurfaceEvent: (event: SurfaceExecutionEventV1) => emittedEvents.push(structuredClone(event)),
  };
  const prepared = runtime.prepareBrowserSession({ identity });
  const target = {
    kind: 'browser' as const,
    browserInstanceId: `managed:durable-persist:${process.pid}`,
    windowRef: `window:durable-persist:${process.pid}`,
    tabRef: `tab:durable-persist:${process.pid}`,
    origin: 'https://fixture.invalid',
    documentRevision: `document:durable-persist:${process.pid}:1`,
    title: 'Durable persistence fixture',
  };
  runtime.recordBrowserObservation({
    identity,
    surfaceSessionId: prepared.session.sessionId,
    target,
    providerGeneration: `managed:durable-persist:${process.pid}:1`,
    evidenceAssetIds: ['evidence-before-restart-initial'],
    userSummary: 'Captured the initial durable checkpoint observation',
  });
  runtime.events.publish(prepared.subject, {
    phase: 'verify',
    status: 'failed',
    userSummary: 'Initial verification failed because the expected fixture state was missing',
    target,
    observation: {
      verdict: 'fail',
      findings: ['Expected fixture state was missing before adjustment.'],
    },
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: ['stop', 'end_session'],
    completedAt: Date.now(),
  });
  runtime.grants.issue({
    subject: prepared.subject,
    target,
    capabilities: ['observe'],
    dataScopes: ['origin:https://fixture.invalid'],
    actionClasses: ['read'],
    ttlMs: 60_000,
  });
  runtime.events.publish(prepared.subject, {
    phase: 'act',
    status: 'succeeded',
    userSummary: 'Adjusted the fixture based on the failed verification',
    target,
    operation: {
      action: 'adjust_fixture',
      risk: 'write',
      expectedOutcome: 'The next independent observation should verify the expected fixture state.',
    },
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: ['pause', 'takeover', 'stop', 'end_session'],
    completedAt: Date.now(),
  });
  const verifiedTarget = {
    ...target,
    documentRevision: `document:durable-persist:${process.pid}:2`,
    title: 'Verified durable persistence fixture',
  };
  const checkpointUserSummary = `Checkpoint verified with ${CANARY} hidden`;
  assert(checkpointUserSummary.includes(CANARY), 'Redaction canary fixture was not injected');
  runtime.recordBrowserObservation({
    identity,
    surfaceSessionId: prepared.session.sessionId,
    target: verifiedTarget,
    providerGeneration: `managed:durable-persist:${process.pid}:2`,
    evidenceAssetIds: ['evidence-before-restart'],
    userSummary: checkpointUserSummary,
  });
  runtime.events.publish(prepared.subject, {
    phase: 'verify',
    status: 'succeeded',
    userSummary: 'Independent verification passed after the fixture adjustment',
    target: verifiedTarget,
    observation: {
      verdict: 'pass',
      findings: ['Expected fixture state is present after adjustment.'],
      confidence: 1,
    },
    evidenceRefs: ['evidence-before-restart'],
    evidence: [{
      version: 1,
      evidenceId: 'evidence-before-restart',
      kind: 'screenshot',
      source: 'browser',
      title: 'Verified fixture state after adjustment',
      capturedAt: Date.now(),
      assetRef: 'artifact://surface-durable/verified-state.png',
      redactionStatus: 'clean',
      inspection: {
        captureState: 'captured',
        analysisState: 'analyzed',
        verificationState: 'verified',
        inspectedBy: { kind: 'agent', id: AGENT_ID, method: 'vision' },
        inspectedAt: Date.now(),
        supportsStepIds: ['verify-after-adjustment'],
        checklist: [{
          id: 'expected-state',
          label: 'Expected fixture state is present',
          status: 'passed',
        }],
      },
    }],
    artifactRefs: ['artifact://surface-durable/final.html'],
    availableControls: ['pause', 'takeover', 'stop', 'end_session'],
    completedAt: Date.now(),
  });
  const live = runtime.snapshotConversation(conversationId);
  const liveProjection = live.sessions.find((candidate) => (
    candidate.session.sessionId === prepared.session.sessionId
  ));
  assert(liveProjection?.writable, 'Production runtime did not expose a writable live checkpoint');
  assert(liveProjection.grant.state === 'active', 'Production runtime did not hold the pre-restart grant');
  assert(
    JSON.stringify(emittedEvents).includes('[redacted-canary]'),
    'SurfaceEventHub did not redact the canary before notifying runtime observers',
  );
  assert(
    !JSON.stringify(emittedEvents).includes(CANARY)
      && !JSON.stringify(liveProjection.events).includes(CANARY),
    'Production runtime event boundary did not redact the canary',
  );
  await service.flushPersistence(conversationId);
  service.dispose();
  registry.clear();
  sessionManager.invalidateSessionCache(conversationId);
  const stored = await sessionManager.getSession(conversationId, Number.MAX_SAFE_INTEGER);
  const record = stored?.metadata?.[SURFACE_EXECUTION_LEDGER_METADATA_KEY];
  assert(record, 'Durable ledger was not persisted through the production SessionManager');
  assert(!JSON.stringify(record).includes(CANARY), 'Persisted session record leaked the canary');
  const sourceExport = await sessionManager.exportSession(conversationId);
  assert(sourceExport, 'Production SessionManager did not export the durable source session');
  const sourceExportPath = join(dirname(resultPath), 'source-session-export.json');
  writeJson(sourceExportPath, sourceExport);
  assert(
    !readFileSync(sourceExportPath).includes(Buffer.from(CANARY, 'utf8')),
    'Source session export leaked the canary',
  );
  const recordSha256 = durableRecordSha256(record);
  await sessionManager.dispose();
  database.close();
  const media = persistentMediaDetails(dataDir, recordSha256);
  assert(
    !readFileSync(media.databasePath).includes(Buffer.from(CANARY, 'utf8')),
    'Production session database leaked the canary',
  );
  writeJson(resultPath, {
    version: 1,
    phase: 'persist',
    pid: process.pid,
    assertions: {
      ledgerPersisted: true,
      canaryRedactedBeforeDisk: true,
      sourceWasWritableBeforeRestart: true,
      productionSessionStorePersisted: true,
      runtimeEventProjectionWired: true,
      activeGrantExistedBeforeRestart: true,
    },
    details: {
      conversationId,
      surfaceSessionId: prepared.session.sessionId,
      persistentMedia: media,
      sourceExport: {
        path: sourceExportPath,
        sha256: sha256File(sourceExportPath),
      },
    } satisfies PersistPhaseDetailsV1,
  } satisfies PhaseResultV1);
}

async function recoverPhase(
  conversationId: string,
  surfaceSessionId: string,
  resultPath: string,
): Promise<void> {
  const dataDir = requireDataDir();
  assert(conversationId.trim() && surfaceSessionId.trim(), 'Recovery requires conversation and Surface session ids');
  const database = await initDatabase();
  const sessionManager = getSessionManager();
  const reopened = await sessionManager.getSession(conversationId, Number.MAX_SAFE_INTEGER);
  assert(reopened?.id === conversationId, 'Recovery did not reopen the persisted conversation');
  const durableRecord = reopened.metadata?.[SURFACE_EXECUTION_LEDGER_METADATA_KEY];
  assert(durableRecord, 'Recovery did not load the durable Surface ledger from the production store');
  const recordSha256 = durableRecordSha256(durableRecord);
  const continuations = new SurfaceContinuationService({ createId: () => 'durable-continuation-request' });
  const service = new SurfaceConversationProjectionService({
    runtime: {
      snapshotConversation: () => ({
        version: 1,
        conversationId,
        sessions: [],
        updatedAt: Date.now(),
      }),
      frames: {
        resolve: async () => {
          throw new Error('Persisted recovery attempted to resolve a live runtime frame.');
        },
      },
      controlConversation: async () => { throw new Error('Persisted continuation bypassed the projection gate.'); },
      subscribeEvents: () => () => undefined,
    },
    sessionStore: sessionManager,
    continuations,
    persistEvents: false,
  });
  const recovered = await service.getSnapshot(conversationId);
  const checkpointProjection = recovered.sessions.find((candidate) => (
    candidate.session.sessionId === surfaceSessionId
  ));
  assert(checkpointProjection, 'Restart did not recover the persisted Surface checkpoint');
  assert(checkpointProjection.source === 'persisted', 'Recovered checkpoint was not marked persisted');
  assert(!checkpointProjection.writable, 'Recovered checkpoint revived write authority');
  assert(checkpointProjection.grant.state === 'revoked', 'Recovered checkpoint revived its old grant');
  assert(
    JSON.stringify(checkpointProjection.availableControls) === JSON.stringify(['continue']),
    'Recovered checkpoint exposed controls other than explicit continuation',
  );
  const prepared = await service.control({
    version: 1,
    conversationId,
    surfaceSessionId,
    action: 'continue',
  });
  assert(prepared.requestId === 'durable-continuation-request', 'Continuation request was not prepared');
  assert(
    prepared.snapshot.sessions[0].availableControls.length === 0,
    'Prepared continuation remained immediately replayable',
  );

  const registry = new RunRegistry();
  registry.start({ runId: CONTINUATION_RUN_ID, sessionId: conversationId, workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry, continuations });
  const identity = {
    conversationId,
    runId: CONTINUATION_RUN_ID,
    agentId: AGENT_ID,
  };
  const next = runtime.prepareBrowserSession({ identity });
  const continuationEvent = runtime.events.listOwned(next.subject).find((event) => (
    event.operation?.action === 'continue_from_checkpoint'
  ));
  assert(next.session.parentSessionId === surfaceSessionId, 'New Session lost the checkpoint parent link');
  assert(Boolean(continuationEvent), 'New Session did not require a fresh observation');
  assert(continuations.peek(conversationId, AGENT_ID) === null, 'Continuation was not single use');
  assert(!next.session.activeTarget, 'Continuation reused the pre-restart target before a fresh observation');
  const fresh = runtime.recordBrowserObservation({
    identity,
    surfaceSessionId: next.session.sessionId,
    target: {
      kind: 'browser',
      browserInstanceId: 'managed:durable-recovery',
      windowRef: `window:durable-recovery:${process.pid}`,
      tabRef: `tab:durable-recovery:${process.pid}`,
      origin: 'https://fixture.invalid',
      documentRevision: `document:durable-recovery:${process.pid}:1`,
      title: 'Fresh durable recovery observation',
    },
    providerGeneration: `managed:durable-recovery:${process.pid}`,
    evidenceAssetIds: ['evidence-after-restart'],
    userSummary: 'Captured a fresh observation after durable recovery',
  });
  assert(fresh.observation.lifecycle === 'fresh', 'Recovery did not capture a fresh observation');
  assert(
    fresh.observation.target.kind === 'browser'
      && fresh.observation.target.documentRevision.includes(String(process.pid)),
    'Recovery observation did not originate in the fresh process',
  );
  await runtime.endRun(identity);
  registry.clear();
  service.dispose();
  const p2Acceptance = await runSurfaceExecutionP2Acceptance();
  assert(
    Object.values(p2Acceptance.assertions).every(Boolean),
    'P2 API acceptance did not verify every required contract',
  );
  await sessionManager.dispose();
  database.close();
  const media = persistentMediaDetails(dataDir, recordSha256);

  writeJson(resultPath, {
    version: 1,
    phase: 'recover',
    pid: process.pid,
    assertions: {
      recoveredReadOnly: true,
      oldGrantRevoked: true,
      onlyExplicitContinueAvailable: true,
      continuationOwnerScoped: true,
      continuationSingleUse: true,
      parentSessionLinked: true,
      freshObservationRequired: true,
      freshObservationCaptured: true,
      cleanupCompleted: true,
      productionSessionStoreReopened: true,
      ...p2Acceptance.assertions,
    },
    details: {
      conversationId,
      recoveredSessionId: surfaceSessionId,
      continuationSessionId: next.session.sessionId,
      parentSessionId: next.session.parentSessionId,
      persistentMedia: media,
      continuationEvent: continuationEvent && {
        phase: continuationEvent.phase,
        status: continuationEvent.status,
        userSummary: continuationEvent.userSummary,
        action: continuationEvent.operation?.action,
        expectedOutcome: continuationEvent.operation?.expectedOutcome,
      },
      freshObservation: {
        stateId: fresh.observation.stateId,
        lifecycle: fresh.observation.lifecycle,
        documentRevision: fresh.observation.target.kind === 'browser'
          ? fresh.observation.target.documentRevision
          : undefined,
      },
      p2Acceptance,
    } satisfies RecoverPhaseDetailsV1 & Record<string, unknown>,
  } satisfies PhaseResultV1);
}

function runChildPhase(
  phase: PhaseResultV1['phase'],
  dataDir: string,
  resultPath: string,
  identity?: { conversationId: string; surfaceSessionId: string },
): { exitCode: number; stdout: string; stderr: string } {
  const scriptPath = fileURLToPath(import.meta.url);
  const childArgs = [
    ...process.execArgv,
    scriptPath,
    '--phase',
    phase,
    '--phase-out',
    resultPath,
    ...(identity ? [
      '--conversation-id',
      identity.conversationId,
      '--surface-session-id',
      identity.surfaceSessionId,
    ] : []),
  ];
  const child = spawnSync(process.execPath, childArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODE_AGENT_DATA_DIR: dataDir,
    },
  });
  return {
    exitCode: child.status ?? 1,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
  };
}

function runReplayImportChild(input: {
  sourceExportPath: string;
  sourceSessionId: string;
  replayDataDir: string;
  resultPath: string;
}): { exitCode: number; stdout: string; stderr: string } {
  const scriptPath = fileURLToPath(new URL('./surface-execution-replay-import-child.ts', import.meta.url));
  const child = spawnSync(process.execPath, [
    ...process.execArgv,
    scriptPath,
    '--source-export',
    input.sourceExportPath,
    '--source-session-id',
    input.sourceSessionId,
    '--out',
    input.resultPath,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODE_AGENT_DATA_DIR: input.replayDataDir,
    },
  });
  return {
    exitCode: child.status ?? 1,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }
  const phase = getStringOption(args, 'phase');
  const phaseOutputPath = getStringOption(args, 'phase-out');
  if (phase) {
    assert(phaseOutputPath, 'Child phase requires a phase output path');
    if (phase === 'persist') await persistPhase(phaseOutputPath);
    else if (phase === 'recover') {
      const conversationId = getStringOption(args, 'conversation-id');
      const surfaceSessionId = getStringOption(args, 'surface-session-id');
      assert(
        conversationId && surfaceSessionId,
        'Recover phase requires only conversation and Surface session identifiers',
      );
      await recoverPhase(conversationId, surfaceSessionId, phaseOutputPath);
    }
    else throw new Error(`Unknown durable acceptance phase: ${phase}`);
    return;
  }

  const outputDir = resolve(getStringOption(args, 'out')
    || mkdtempSync(join(tmpdir(), 'surface-execution-durable-proof-')));
  mkdirSync(outputDir, { recursive: true });
  const dataDir = resolve(process.env.CODE_AGENT_DATA_DIR?.trim()
    || mkdtempSync(join(tmpdir(), 'code-agent-surface-durable-data-')));
  mkdirSync(dataDir, { recursive: true });
  const replayDataDir = resolve(mkdtempSync(join(tmpdir(), 'code-agent-surface-replay-data-')));
  assert(replayDataDir !== dataDir, 'Fresh replay reused the source persistence directory');
  const persistResultPath = join(outputDir, 'persist-process.json');
  const recoverResultPath = join(outputDir, 'recover-process.json');
  const replayResultPath = join(outputDir, 'replay-import-process.json');
  const sourceFingerprint = surfaceAcceptanceSourceFingerprint();
  const persistChild = runChildPhase('persist', dataDir, persistResultPath);
  assert(persistChild.exitCode === 0, `Persist child failed: ${persistChild.stderr || persistChild.stdout}`);
  const persisted = readJson<PhaseResultV1>(persistResultPath);
  const persistDetails = persisted.details as unknown as PersistPhaseDetailsV1;
  assert(
    typeof persistDetails.conversationId === 'string'
      && typeof persistDetails.surfaceSessionId === 'string',
    'Persist phase did not return durable record identifiers',
  );
  const recoverChild = runChildPhase('recover', dataDir, recoverResultPath, {
    conversationId: persistDetails.conversationId,
    surfaceSessionId: persistDetails.surfaceSessionId,
  });
  assert(recoverChild.exitCode === 0, `Recover child failed: ${recoverChild.stderr || recoverChild.stdout}`);
  const recovered = readJson<PhaseResultV1>(recoverResultPath);
  const recoverDetails = recovered.details as unknown as RecoverPhaseDetailsV1;
  assert(
    recoverDetails.p2Acceptance?.assertions.providerImplementationDefersExact === true,
    'Recovery did not return the exact P2 provider implementation defer evidence',
  );
  assert(persisted.pid !== recovered.pid, 'Persistence and recovery ran in the same process');
  assert(persisted.pid !== process.pid && recovered.pid !== process.pid, 'A phase reused the orchestrator process');
  assert(
    persistDetails.persistentMedia.dataDir === recoverDetails.persistentMedia.dataDir
      && persistDetails.persistentMedia.dataDir === dataDir,
    'Persistence and recovery did not share the same CODE_AGENT_DATA_DIR',
  );
  assert(
    persistDetails.persistentMedia.databasePath === recoverDetails.persistentMedia.databasePath,
    'Recovery reopened a different persistent medium',
  );
  assert(
    persistDetails.persistentMedia.recordSha256 === recoverDetails.persistentMedia.recordSha256,
    'Recovered Surface ledger differs from the persisted record',
  );
  assert(
    recoverDetails.conversationId === persistDetails.conversationId
      && recoverDetails.recoveredSessionId === persistDetails.surfaceSessionId,
    'Recovery reopened a record other than the identifier-selected Surface session',
  );
  const replayChild = runReplayImportChild({
    sourceExportPath: persistDetails.sourceExport.path,
    sourceSessionId: persistDetails.conversationId,
    replayDataDir,
    resultPath: replayResultPath,
  });
  assert(
    replayChild.exitCode === 0,
    `Fresh replay import child failed: ${replayChild.stderr || replayChild.stdout}`,
  );
  const replayed = readJson<ReplayImportResultV1>(replayResultPath);
  assert(replayed.status === 'passed', 'Fresh replay import did not report a passing result');
  assert(
    Object.values(replayed.assertions).every(Boolean),
    'Fresh replay import did not verify every safety and semantic assertion',
  );
  assert(
    replayed.pid !== process.pid && replayed.pid !== persisted.pid && replayed.pid !== recovered.pid,
    'Fresh replay import reused the orchestrator, persistence, or recovery process',
  );
  assert(
    replayed.semantics.sourceSha256 === replayed.semantics.replaySha256
      && replayed.semantics.sourceEventCount === replayed.semantics.replayEventCount,
    'Fresh replay import changed the exported Surface semantics',
  );
  const checkpointArtifactPath = join(outputDir, 'durable-checkpoint-evidence.json');
  writeJson(checkpointArtifactPath, {
    version: 1,
    conversationId: persistDetails.conversationId,
    recoveredSessionId: recoverDetails.recoveredSessionId,
    continuationSessionId: recoverDetails.continuationSessionId,
    parentSessionId: recoverDetails.parentSessionId,
    persistPid: persisted.pid,
    recoverPid: recovered.pid,
    dataDirectoryMatched: persistDetails.persistentMedia.dataDir === recoverDetails.persistentMedia.dataDir,
    databasePathMatched: persistDetails.persistentMedia.databasePath
      === recoverDetails.persistentMedia.databasePath,
    persistedRecordSha256: persistDetails.persistentMedia.recordSha256,
    recoveredRecordSha256: recoverDetails.persistentMedia.recordSha256,
    assertions: {
      recoveredReadOnly: recovered.assertions['recoveredReadOnly'] === true,
      oldGrantRevoked: recovered.assertions['oldGrantRevoked'] === true,
      continuationSingleUse: recovered.assertions['continuationSingleUse'] === true,
      parentSessionLinked: recovered.assertions['parentSessionLinked'] === true,
      freshObservationCaptured: recovered.assertions['freshObservationCaptured'] === true,
    },
  });
  const filesBeforeProof = assertAcceptanceCanaryAbsent(CANARY, [dataDir, replayDataDir, outputDir]);
  assert(
    filesBeforeProof.includes(persistDetails.persistentMedia.databasePath),
    'No production session persistence medium was available to scan',
  );

  const campaignProof = surfaceAcceptanceCampaignProofFields();
  const proofAssertions: Record<string, boolean> = {
    realProcessBoundary: true,
    sharedDataDirectory: true,
    recoveryIdentifierOnly: true,
    persistentRecordDigestMatched: true,
    freshProcessReplayBoundary: true,
    isolatedReplayDataDirectory: true,
    ...persisted.assertions,
    ...recovered.assertions,
    ...replayed.assertions,
    redactionCanaryAbsent: true,
  };
  const proof = {
    version: 1,
    status: 'passed',
    scenario: 'durable-production-session-store-real-process-restart-readonly-explicit-continuation',
    recordedAt: new Date().toISOString(),
    worktree: process.cwd(),
    command: acceptanceCommand(),
    sourceFingerprint,
    ...campaignProof,
    processes: {
      orchestratorPid: process.pid,
      persistPid: persisted.pid,
      recoverPid: recovered.pid,
      replayPid: replayed.pid,
      distinct: true,
      persistExitCode: persistChild.exitCode,
      recoverExitCode: recoverChild.exitCode,
      replayExitCode: replayChild.exitCode,
    },
    assertions: proofAssertions,
    p2Acceptance: recoverDetails.p2Acceptance,
    evidence: {
      persistentStore: {
        dataDir,
        databasePath: persistDetails.persistentMedia.databasePath,
        recordKey: persistDetails.persistentMedia.recordKey,
        persistedRecordSha256: persistDetails.persistentMedia.recordSha256,
        recoveredRecordSha256: recoverDetails.persistentMedia.recordSha256,
        persistDatabaseSha256: persistDetails.persistentMedia.databaseSha256,
        recoverDatabaseSha256: recoverDetails.persistentMedia.databaseSha256,
      },
      checkpoint: {
        path: basename(checkpointArtifactPath),
        sha256: sha256File(checkpointArtifactPath),
        bytes: statSync(checkpointArtifactPath).size,
        businessReadback: 'Persisted checkpoint reopened read-only; old grant revoked; explicit single-use continuation captured a fresh observation.',
      },
      replayImport: {
        path: basename(replayResultPath),
        sha256: sha256File(replayResultPath),
        bytes: statSync(replayResultPath).size,
        targetDataDir: replayDataDir,
        sourceSemanticSha256: replayed.semantics.sourceSha256,
        replaySemanticSha256: replayed.semantics.replaySha256,
        sourceEventCount: replayed.semantics.sourceEventCount,
        replayEventCount: replayed.semantics.replayEventCount,
        businessReadback: 'A fresh process imported the safe archive into an isolated store and reproduced verify-fail, adjust, verify-pass semantics without reviving authority.',
      },
      persistProcess: persisted,
      recoverProcess: recovered,
      replayProcess: replayed,
    },
    canaryScan: {
      tokenSha256: sha256Text(CANARY),
      result: 'absent',
      scannedFiles: filesBeforeProof.map((path) => (
        path.startsWith(`${dataDir}/`)
          ? `source-data/${relative(dataDir, path)}`
          : path.startsWith(`${replayDataDir}/`)
            ? `replay-data/${relative(replayDataDir, path)}`
            : `output/${relative(outputDir, path)}`
      )),
    },
  };
  assert(!JSON.stringify(proof).includes(CANARY), 'Durable restart proof leaked the canary');
  const proofPath = join(outputDir, 'proof.json');
  writeJson(proofPath, proof);
  const runLogPath = join(outputDir, 'run.log');
  writeFileSync(runLogPath, [
    'Surface Execution durable restart acceptance',
    `recordedAt=${proof.recordedAt}`,
    `sourceFingerprint=${sourceFingerprint.sha256}`,
    `persistPid=${persisted.pid}`,
    `recoverPid=${recovered.pid}`,
    `replayPid=${replayed.pid}`,
    `dataDir=${dataDir}`,
    `databasePath=${persistDetails.persistentMedia.databasePath}`,
    `persistedRecordSha256=${persistDetails.persistentMedia.recordSha256}`,
    `recoveredRecordSha256=${recoverDetails.persistentMedia.recordSha256}`,
    'recoveredReadOnly=true',
    'oldGrantRevoked=true',
    'continuationSingleUse=true',
    'parentSessionLinked=true',
    'freshObservationCaptured=true',
    `freshProcessReplayBoundary=${proof.assertions['freshProcessReplayBoundary']}`,
    `replayExplicitSurfaceEvents=${proof.assertions['replayExplicitSurfaceEvents']}`,
    `failureAdjustPassReproduced=${proof.assertions['failureAdjustPassReproduced']}`,
    `semanticDigestMatched=${proof.assertions['semanticDigestMatched']}`,
    `externalSurfaceAdapterContractVerified=${proof.assertions['externalSurfaceAdapterContractVerified']}`,
    `organizationPolicyAuditRetentionVerified=${proof.assertions['organizationPolicyAuditRetentionVerified']}`,
    `providerNeutralRegistryContractVerified=${proof.assertions['providerNeutralRegistryContractVerified']}`,
    'canaryScan=absent',
    '',
  ].join('\n'), 'utf8');
  assertAcceptanceCanaryAbsent(CANARY, [dataDir, replayDataDir, outputDir]);

  const result = {
    ok: true,
    outputDir,
    proofPath,
    proofSha256: sha256File(proofPath),
    sourceFingerprint: sourceFingerprint.sha256,
    ...proof.assertions,
  };
  if (hasFlag(args, 'json')) printJson(result);
  else printKeyValue('Surface Execution Durable Restart Acceptance', [
    ['ok', true],
    ['persistPid', persisted.pid],
    ['recoverPid', recovered.pid],
    ['replayPid', replayed.pid],
    ['sourceFingerprint', sourceFingerprint.sha256],
    ['proofPath', proofPath],
  ]);
}

main().catch(finishWithError);
