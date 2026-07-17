import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { GraphEvent } from '../../../src/host/orchestration/graphEvents';
import type { PendingOperation, RunOwnerLease } from '../../../src/shared/contract/durableRun';
import type { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import type { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import type { DurableRunKillRestartScenario } from '../../fixtures/durableRunKillRestart';

interface PersistedAcceptanceState {
  schemaVersion: 1;
  scenarioId: string;
  runId: string;
  sessionId: string;
  graphId: string;
  traceId: string;
  operationId: string;
  idempotencyKey: string;
  oldOwner: RunOwnerLease;
  completedNodes: string[];
  approvalId?: string;
  externalSessionId?: string;
  workspaceFingerprint: string;
  currentWorkspaceFingerprint: string;
}

interface Counters {
  modelDispatches: number;
  providerQueries: number;
  sideEffectWrites: number;
  outputCommits: number;
  approvalCards: number;
  childSchedules: number;
  completedNodeExecutions: number;
  recoveredNodeExecutions: number;
  fakeCliResumes: number;
}

const [phase, scenarioId, dataDir] = process.argv.slice(2);
const { DURABLE_RUN_KILL_RESTART_SCENARIOS } = await import('../../fixtures/durableRunKillRestart');
const scenario = DURABLE_RUN_KILL_RESTART_SCENARIOS.find((candidate) => candidate.id === scenarioId);
if (!phase || !scenario || !dataDir) throw new Error('usage: durableRunProcessHost <prepare|recover> <scenario> <data-dir>');

await mkdir(dataDir, { recursive: true });
const { default: Database } = await import('better-sqlite3');
const { applyDurableRunMigrationDraft } = await import('../../../src/host/services/core/database/migrations/durableRun');
const { DurableRunRepository: ProductionDurableRunRepository } = await import('../../../src/host/services/core/repositories/DurableRunRepository');
const dbPath = path.join(dataDir, 'durable-run.sqlite');
const countersPath = path.join(dataDir, 'counters.json');
const providerResultPath = path.join(dataDir, 'provider-result.json');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
applyDurableRunMigrationDraft(db);
const repository: DurableRunRepository = new ProductionDurableRunRepository(db);
const { DurableRunKernel: ProductionDurableRunKernel } = await import('../../../src/host/runtime/durableRunKernel');

if (phase === 'prepare') await prepareAndWait(scenario);
else if (phase === 'recover') await recoverAndExit(scenario);
else throw new Error(`unknown phase: ${phase}`);

async function prepareAndWait(selected: DurableRunKillRestartScenario): Promise<never> {
  const now = Date.now();
  const runId = `acceptance-${selected.id}`;
  const sessionId = `session-${selected.coreId}`;
  const kernel = createKernel('old-owner', `old-process-${process.pid}`, 300);
  const mcpPayload = selected.id === 'mcp-durable-task-queryable'
    ? Buffer.from(JSON.stringify({
        version: 1, taskId: 'task-stable', runId,
        operationId: `operation-${selected.coreId}`, serverIdentity: 'trusted-server',
      })).toString('base64url')
    : null;
  const providerOperationId = mcpPayload
    ? `mcp-task:v1:${mcpPayload}.${createHash('sha256').update(`mcp-task:v1:${mcpPayload}`).digest('hex').slice(0, 32)}`
    : selected.providerOperationId;
  const prepared = kernel.prepareOperation({
    runId,
    operationId: `operation-${selected.coreId}`,
    logicalOperationId: `logical-${selected.coreId}`,
    attempt: 1,
    kind: selected.operationKind,
    sideEffect: selected.sideEffect,
    canDeduplicate: Boolean(providerOperationId),
    providerOperationId,
    now,
  });
  const operation: PendingOperation = {
    ...prepared,
    status: selected.coreId === 'dynamic-workflow' ? 'succeeded' : selected.operationStatus,
    ...(selected.coreId === 'dynamic-workflow' ? { resultRef: 'nested-checkpoint:prepared' } : {}),
  };
  const childRuns = selected.coreId === 'child-agent-running'
    ? [
        { parentRunId: runId, childRunId: 'child-completed', relation: 'agent' as const, status: 'completed' as const, createdAt: now - 2, terminalAt: now - 1 },
        { parentRunId: runId, childRunId: 'child-running', relation: 'agent' as const, status: 'running' as const, createdAt: now },
      ]
    : [];
  const externalEngine = selected.engine.kind === 'external_cli' ? selected.engine : null;
  const engineCursor = selected.coreId === 'agent-team-auto-agent'
    ? {
        schemaVersion: 1, runtime: 'auto_agent', sourceMessageId: 'message-auto-agent-stable',
        graphId: `graph-${selected.coreId}`, workspaceFingerprint: 'workspace-fingerprint-v1',
      }
    : externalEngine
    ? { schemaVersion: 1, engine: externalEngine.engine, externalSessionId: externalEngine.externalSessionId }
    : { graphId: `graph-${selected.coreId}`, traceId: `trace-${selected.coreId}` };
  const created = await kernel.createRun({
    runId,
    sessionId,
    engine: selected.engine,
    now,
    initialStatus: selected.expectedOutcome === 'waiting_approval' ? 'waiting' : 'running',
    initialPendingOperations: [operation],
    initialChildRuns: childRuns,
    initialEngineCursor: engineCursor,
  });
  let state: PersistedAcceptanceState & Record<string, unknown> = {
    schemaVersion: 1,
    scenarioId: selected.id,
    runId,
    sessionId,
    graphId: `graph-${selected.coreId}`,
    traceId: `trace-${selected.coreId}`,
    operationId: operation.operationId,
    idempotencyKey: operation.idempotencyKey,
    oldOwner: created.owner,
    completedNodes: selected.coreId === 'dynamic-workflow' || selected.coreId === 'agent-team-auto-agent'
      ? ['nested-completed'] : [],
    ...(selected.coreId === 'approval-waiting' ? { approvalId: 'approval-stable-1' } : {}),
    ...(selected.engine.kind === 'external_cli' && selected.engine.externalSessionId
      ? { externalSessionId: selected.engine.externalSessionId } : {}),
    workspaceFingerprint: 'workspace-fingerprint-v1',
    currentWorkspaceFingerprint: selected.id === 'dynamic-workflow-drift'
      ? 'workspace-fingerprint-drifted' : 'workspace-fingerprint-v1',
    ...(externalEngine ? {
      engineKind: 'external_cli',
      engine: externalEngine.engine,
      workspace: { cwd: dataDir, fingerprint: 'acceptance-workspace' },
      permissionProfile: 'read_only',
      model: 'deterministic-model',
    } : {}),
  };
  if (selected.engine.kind === 'native') {
    state = {
      ...state,
      kind: 'native',
      sourceMessageId: `message-${selected.coreId}`,
      provider: 'deterministic',
      model: 'deterministic-model',
      workspace: { root: dataDir, cwd: dataDir, fingerprint: state.workspaceFingerprint },
      logicalOperationId: operation.operationId,
      phase: selected.coreId === 'approval-waiting' ? 'approval_waiting'
        : selected.coreId === 'between-tool-begin-end' || selected.coreId === 'mcp-durable-task' ? 'tool_dispatched'
          : operation.status === 'prepared' ? 'before_model_dispatch' : 'after_model_dispatch',
      checkpointSequence: 1,
    };
  }
  if (selected.coreId === 'dynamic-workflow') {
    const graphSpec = {
      graphId: state.graphId, runId, sessionId, attempt: 1,
      schedulerPolicy: { maxConcurrency: 1 },
      nodes: [{
        nodeId: 'workflow-node', kind: 'dynamic_workflow', executorRef: 'dynamic_workflow',
        dependencies: [], sideEffect: 'read_only',
        input: {
          script: 'return 1', defaultProvider: 'deterministic', defaultModel: 'deterministic-model',
          workflowRunId: 'workflow-stable', journalRunId: 'workflow-stable',
        },
      }],
    };
    state = {
      ...state,
      engineKind: 'dynamic_workflow',
      workspace: { root: dataDir, cwd: dataDir, fingerprint: state.workspaceFingerprint },
      model: { provider: 'deterministic', model: 'deterministic-model' },
      toolProfile: 'readonly',
      graphSpec,
      graphCheckpoint: {
        version: 1, graphId: state.graphId, runId, sessionId, attempt: 1,
        status: 'running', eventSequence: 1,
        scheduler: { version: 1, nodes: [{ nodeId: 'workflow-node', status: 'running', attempts: 1 }], cancelled: false },
        nodes: [{ nodeId: 'workflow-node', status: 'running', attempts: 1 }],
        createdAt: now, updatedAt: now,
      },
    };
  }
  if (selected.coreId === 'child-agent-running') {
    state = {
      ...state,
      kind: 'agent_team',
      teamId: runId,
      treeId: 'team-run-stable',
      scope: { sessionId, runId, treeId: 'team-run-stable' },
      parentRunId: 'native-parent-stable',
      taskGraph: [
        {
          id: 'child-completed', role: 'read', task: 'completed', dependsOn: [], tools: ['Read'],
          permissionProfile: 'readonly', sideEffect: false, status: 'completed',
          operationId: 'completed-operation', resultRef: 'result:child-completed', artifactRefs: [],
        },
        {
          id: 'child-running', role: 'write', task: 'running', dependsOn: [], tools: ['Write'],
          permissionProfile: 'write', sideEffect: true, status: 'dispatched',
          operationId: operation.operationId, artifactRefs: [],
        },
      ],
      mailbox: { nextSeq: 1, committedCursor: 0, pending: [], consumedMessageIds: [] },
      findings: {}, decisions: {}, errors: [],
      completedNodeResultRefs: { 'child-completed': 'result:child-completed' },
      runningChildRefs: ['child-running'], pendingApprovalRefs: [], worktreeRefs: {}, artifactRefs: {},
      cancelled: false, updatedAt: now,
    };
  }
  if (selected.coreId === 'agent-team-auto-agent') {
    state = {
      ...state,
      kind: 'auto_agent',
      sourceMessageId: 'message-auto-agent-stable',
      workspace: { root: dataDir, cwd: dataDir, fingerprint: state.workspaceFingerprint },
      graphCheckpoint: {
        version: 1, graphId: state.graphId, runId, sessionId, attempt: 1,
        status: 'running', eventSequence: 1,
        scheduler: { version: 1, nodes: [
          { nodeId: 'nested-completed', status: 'completed', attempts: 1 },
          { nodeId: 'nested-recover', status: 'ready', attempts: 0 },
        ], cancelled: false },
        nodes: [
          { nodeId: 'nested-completed', status: 'completed', attempts: 1, result: { status: 'completed', sideEffectState: 'confirmed' } },
          { nodeId: 'nested-recover', status: 'ready', attempts: 0 },
        ],
        createdAt: now, updatedAt: now,
      },
      cancelled: false,
    };
  }
  await kernel.checkpoint({
    runId,
    attempt: 1,
    owner: created.owner,
    now,
    status: selected.expectedOutcome === 'waiting_approval' ? 'waiting' : 'running',
    state,
    engineCursor,
    pendingOperations: [operation],
    childRuns,
    events: [{ type: 'fault_point_ready', payload: { scenarioId: selected.id }, recordedAt: now }],
  });
  const counters = emptyCounters();
  if (selected.coreId === 'approval-waiting') counters.approvalCards = 1;
  if (selected.coreId === 'child-agent-running') counters.childSchedules = 2;
  if (state.completedNodes.length > 0) counters.completedNodeExecutions = state.completedNodes.length;
  await saveCounters(counters);
  if (selected.id === 'after-model-response-queryable') {
    await writeFile(providerResultPath, JSON.stringify({ operationId: operation.operationId, result: 'original-result' }));
  }
  marker({ marker: 'ready', scenarioId: selected.id, pid: process.pid, runId, oldOwnerEpoch: 1, attempt: 1 });
  await new Promise<never>(() => setInterval(() => undefined, 1_000));
  throw new Error('unreachable');
}

async function recoverAndExit(selected: DurableRunKillRestartScenario): Promise<void> {
  const [{ initializeDurableRun }, { RunRegistry }] = await Promise.all([
    import('../../../src/host/app/initializeDurableRun'),
    import('../../../src/host/runtime/runRegistry'),
  ]);
  const registry = new RunRegistry();
  let staleWriteRejected = false;
  let recoveryAction = selected.expectedRecoveryAction;
  let requiresReviewReason: string | null = null;
  let graphTerminalCount = 0;
  let logicalIdentityLinked = false;
  const fakeExternalRunner = async (request: {
    sessionId: string;
    durableLifecycle?: {
      runId: string;
      engine: string;
      finish(result: { runId: string; sessionId: string; engine: 'codex_cli'; status: 'completed'; exitCode: number }, terminalEvidence: boolean): Promise<void>;
    };
    resumeLaunch?: { externalSessionId: string; runId: string; sessionId: string; attempt: number; ownerEpoch: number };
  }) => {
    const externalSessionId = request.resumeLaunch?.externalSessionId;
    const fake = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({sessionId:process.argv[1]}))', externalSessionId ?? ''], { encoding: 'utf8' });
    if (fake.status !== 0 || JSON.parse(fake.stdout).sessionId !== externalSessionId) throw new Error('fake CLI resume lost session identity');
    const counters = await loadCounters();
    counters.fakeCliResumes += 1;
    await saveCounters(counters);
    const result = {
      runId: request.durableLifecycle!.runId,
      sessionId: request.sessionId,
      engine: request.durableLifecycle!.engine as 'codex_cli',
      status: 'completed' as const,
      exitCode: 0,
    };
    await request.durableLifecycle!.finish(result, true);
    return result;
  };
  const fakeMcpProtocol = {
    createTask: async () => { throw new Error('recovery must not create MCP tasks'); },
    getTask: async () => {
      const counters = await loadCounters();
      counters.providerQueries += 1;
      await saveCounters(counters);
      return {
        taskId: 'task-stable', status: 'completed' as const, ttl: 60_000,
        createdAt: '2026-07-12T00:00:00Z', lastUpdatedAt: '2026-07-12T00:00:01Z',
      };
    },
    cancelTask: async () => { throw new Error('unused'); },
    resolveTaskResult: async () => ({ content: [{ type: 'text', text: 'deterministic-result' }] }),
  };
  const fakeMcpClient = {
    getServerStates: () => [{ config: { name: 'fake-mcp' } }],
    getServerIdentity: () => 'trusted-server',
    getTools: () => [{ serverName: 'fake-mcp', name: 'durable_task' }],
    buildTaskCapability: () => ({
      serverIdentity: 'trusted-server', trusted: true, serverToolsCall: true,
      query: true, cancel: true, toolTaskSupport: 'optional' as const,
    }),
    createTaskProtocol: () => fakeMcpProtocol,
  };
  const dynamicWorkflowHost = {
    resolve: async () => {
      if (selected.id === 'dynamic-workflow-drift') {
        return { ok: false as const, reason: 'workspace_model_tool_drift' };
      }
      const counters = await loadCounters();
      counters.recoveredNodeExecutions += 1;
      await saveCounters(counters);
      return {
        ok: true as const,
        workspace: dataDir,
        cwd: dataDir,
        deps: {
          baseModelConfig: { provider: 'deterministic', model: 'deterministic-model' },
          resolveModelConfig: () => ({ provider: 'deterministic', model: 'deterministic-model' }),
          deriveSubagentContext: () => ({}),
          resolveAgentTools: () => ({ tools: [], writeCapable: false }),
          useOsSandbox: false,
        } as never,
      };
    },
  };
  const nativeRecoveryPorts = {
    resolveWorkspace: async (descriptor: { workspace: { root: string; cwd: string; fingerprint: string } }) => ({
      ok: true as const,
      ...descriptor.workspace,
    }),
    model: {
      dispatchPrepared: async () => {
        const counters = await loadCounters();
        counters.modelDispatches += 1;
        await saveCounters(counters);
        return { resultRef: 'model-result:prepared' };
      },
      queryResult: async () => {
        const result = JSON.parse(await readFile(providerResultPath, 'utf8')) as { result: string };
        if (result.result !== 'original-result') throw new Error('provider result identity changed');
        const counters = await loadCounters();
        counters.providerQueries += 1;
        await saveCounters(counters);
        return { resultRef: 'model-result:queried' };
      },
      canRetrySafely: async () => selected.id === 'after-model-response-safe-retry',
      retrySafe: async () => {
        const counters = await loadCounters();
        counters.modelDispatches += 1;
        await saveCounters(counters);
        return { resultRef: 'model-result:safe-retry' };
      },
    },
    tool: {
      queryResult: async () => {
        const counters = await loadCounters();
        counters.providerQueries += 1;
        await saveCounters(counters);
        return { resultRef: 'tool-result:deduplicated' };
      },
    },
    approval: {
      read: async (approvalId: string) => approvalId === 'approval-stable-1' ? 'pending' as const : 'missing' as const,
    },
    compatibilitySink: {
      commitResult: async () => {
        const counters = await loadCounters();
        counters.outputCommits += 1;
        await saveCounters(counters);
      },
    },
  };
  const { AutoAgentRecoveryHost } = await import('../../../src/host/runtime/autoAgentRecoveryHost');
  const autoAgentRecoveryHost = new AutoAgentRecoveryHost(registry, {
    async resume({ plan, state, emit, persist }) {
      const counters = await loadCounters();
      counters.recoveredNodeExecutions += 1;
      await saveCounters(counters);
      const checkpoint = {
        ...state.graphCheckpoint,
        attempt: plan.envelope.attempt,
        status: 'completed' as const,
        eventSequence: state.graphCheckpoint.eventSequence + 1,
        nodes: state.graphCheckpoint.nodes.map((node) => node.nodeId === 'nested-recover'
          ? { ...node, status: 'completed' as const, attempts: node.attempts + 1, result: { status: 'completed' as const, sideEffectState: 'confirmed' as const } }
          : node),
        updatedAt: Date.now(),
        terminalEventType: 'graph_completed' as const,
      };
      await persist(checkpoint);
      const terminal: GraphEvent = {
        type: 'graph_completed', graphId: checkpoint.graphId, runId: checkpoint.runId,
        sessionId: checkpoint.sessionId, attempt: plan.envelope.attempt,
        sequence: checkpoint.eventSequence, timestamp: checkpoint.updatedAt, graphStatus: 'completed',
      };
      await emit(terminal);
      await emit(terminal);
      return { status: 'completed' as const, checkpoint, results: {} };
    },
  }, {
    graph: () => { graphTerminalCount += 1; },
    agent: () => undefined,
    diagnostic: () => undefined,
  });
  const runtime = await initializeDurableRun({
    registry,
    repository,
    dataDir,
    ownerId: 'new-owner',
    processInstanceId: `new-process-${process.pid}`,
    env: { CODE_AGENT_DURABLE_RUN_MODE: 'durable_preferred' },
    leaseDurationMs: 2_000,
    now: Date.now(),
    externalRunners: { codex: fakeExternalRunner as never, claude: fakeExternalRunner as never },
    getMcpClient: () => fakeMcpClient as never,
    trustedMcpServerIdentities: new Set(['trusted-server']),
    dynamicWorkflowHost,
    nativeRecoveryPorts,
    autoAgentRecoveryHost,
  });

  const latestAfterRecovery = await repository.get(`acceptance-${selected.id}`);
  const originalState = JSON.parse(String((db.prepare(`SELECT state_json FROM durable_run_checkpoints
    WHERE run_id = ? AND checkpoint_seq = 1`).get(`acceptance-${selected.id}`) as { state_json: string }).state_json)) as PersistedAcceptanceState;
  logicalIdentityLinked = latestAfterRecovery?.runId === originalState.runId
    && latestAfterRecovery.sessionId === originalState.sessionId
    && (latestAfterRecovery.engine.kind !== 'external_cli'
      || latestAfterRecovery.engine.externalSessionId === originalState.externalSessionId);
  const engineResult = runtime.recoveryResults.find((result) => result.phase === 'engine');
  const operationResult = runtime.recoveryResults.find((result) => result.phase === 'operation');
  recoveryAction = (selected.coreId === 'mcp-durable-task' ? operationResult?.reason : engineResult?.reason) ?? recoveryAction;
  if (selected.expectedOutcome === 'waiting_review') requiresReviewReason = recoveryAction;
  if (runtime.kernel && latestAfterRecovery) {
    try {
      await runtime.kernel.checkpoint({
        runId: latestAfterRecovery.runId,
        attempt: 1,
        owner: originalState.oldOwner,
        now: Date.now(),
        status: 'running',
        state: originalState,
        pendingOperations: latestAfterRecovery.pendingOperations ?? [],
        childRuns: latestAfterRecovery.childRuns,
        events: [{ type: 'stale_write', payload: null, recordedAt: Date.now() }],
      });
    } catch {
      staleWriteRejected = true;
    }
  }

  const envelope = await repository.get(`acceptance-${selected.id}`);
  if (!envelope) throw new Error('recovered envelope missing');
  const events = await repository.read(envelope.runId, 0, 1_000);
  const attempts = db.prepare('SELECT attempt, owner_epoch, process_instance_id, status FROM durable_run_attempts WHERE run_id = ? ORDER BY attempt')
    .all(envelope.runId) as Array<{ attempt: number; owner_epoch: number; process_instance_id: string; status: string }>;
  const counters = await loadCounters();
  const terminalCount = envelope.terminal ? 1 : 0;
  const eventSequences = events.map((event) => event.seq);
  const monotonic = eventSequences.every((value, index) => index === 0 || value > eventSequences[index - 1]!);
  const operation = (await repository.listPendingOperations(envelope.runId))[0];
  const state = (await repository.getLatest(envelope.runId))?.state as PersistedAcceptanceState & { recoveredByPid?: number };
  const initialState = JSON.parse(String((db.prepare(`SELECT state_json FROM durable_run_checkpoints
    WHERE run_id = ? AND checkpoint_seq = 1`).get(envelope.runId) as { state_json: string }).state_json)) as PersistedAcceptanceState & { recoveredByPid?: number };
  const evidenceState = selected.coreId === 'external-engine'
    || selected.coreId === 'dynamic-workflow'
    || selected.id === 'child-agent-running' ? initialState : state;
  const completedNodesReexecuted = counters.completedNodeExecutions > 1 ? counters.completedNodeExecutions - 1 : 0;
  const duplicateSideEffectCount = counters.sideEffectWrites;
  const pass = attempts.length === 2
    && attempts[1]!.owner_epoch > attempts[0]!.owner_epoch
    && envelope.attempt === 2
    && staleWriteRejected
    && monotonic
    && terminalCount <= 1
    && operation?.idempotencyKey === initialState.idempotencyKey
    && completedNodesReexecuted === 0
    && duplicateSideEffectCount === 0
    && logicalIdentityLinked
    && (selected.expectedOutcome === 'completed'
      ? envelope.status === 'completed' && terminalCount === 1
      : selected.expectedOutcome === 'observing'
        ? envelope.status === 'running' && terminalCount === 0
        : envelope.status === 'waiting')
    && (selected.expectedOutcome === 'waiting_review' ? requiresReviewReason === selected.requiresReviewReason : true)
    && (selected.id === 'approval-waiting' ? counters.approvalCards === 1 : true)
    && (selected.id === 'child-agent-running' ? counters.childSchedules === 2 : true)
    && (selected.id === 'agent-team-auto-agent' ? graphTerminalCount === 1 : true)
    && (selected.id === 'mcp-durable-task-queryable' ? operation?.status === 'succeeded' && counters.providerQueries === 1 : true)
    && attempts[1]!.process_instance_id !== attempts[0]!.process_instance_id
    ;
  const engineDispatch = engineResult;
  const operationDispatch = operationResult;
  const productionRecoveryPath = selected.coreId === 'mcp-durable-task'
    ? operationDispatch?.handler === 'mcp_tool_call'
    : Boolean(engineDispatch && !engineDispatch.handler.startsWith('acceptance_'));

  marker({
    marker: 'result', scenarioId: selected.id, coreId: selected.coreId, pass,
    recoveryAction, oldOwnerEpoch: attempts[0]!.owner_epoch, newOwnerEpoch: attempts[1]!.owner_epoch,
    attempt: envelope.attempt, terminalCount, duplicateSideEffectCount, requiresReviewReason,
    rolloutMode: runtime.policy.mode, staleWriteRejected, eventSequenceMonotonic: monotonic,
    completedNodesReexecuted, operationKeyStable: operation?.idempotencyKey === initialState.idempotencyKey,
    identityLinked: logicalIdentityLinked, oldProcessInstanceId: attempts[0]!.process_instance_id,
    newProcessInstanceId: attempts[1]!.process_instance_id, recoveredByPid: evidenceState.recoveredByPid ?? process.pid,
    counters, dispatchResults: runtime.recoveryResults, productionRecoveryPath,
  });
  await runtime.shutdown();
  db.close();
}

function createKernel(ownerId: string, processInstanceId: string, leaseDurationMs: number): DurableRunKernel {
  return new ProductionDurableRunKernel({ stores: repository, ownerId, processInstanceId, leaseDurationMs });
}

function emptyCounters(): Counters {
  return {
    modelDispatches: 0, providerQueries: 0, sideEffectWrites: 0, outputCommits: 0,
    approvalCards: 0, childSchedules: 0, completedNodeExecutions: 0,
    recoveredNodeExecutions: 0, fakeCliResumes: 0,
  };
}

async function loadCounters(): Promise<Counters> {
  return JSON.parse(await readFile(countersPath, 'utf8')) as Counters;
}

async function saveCounters(counters: Counters): Promise<void> {
  await writeFile(countersPath, JSON.stringify(counters));
}

function marker(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
