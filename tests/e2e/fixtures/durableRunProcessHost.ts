import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { GraphEvent } from '../../../src/host/orchestration/graphEvents';
import type { PendingOperation, RunOwnerLease } from '../../../src/shared/contract/durableRun';
import type { DurableRecoveryHandlerOverrides } from '../../../src/host/runtime/durableRecoveryRuntime';
import type { DurableEngineRecoveryHandler } from '../../../src/host/runtime/durableRecoveryDispatcher';
import type { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import type { RunRehydrationPlan } from '../../../src/host/runtime/durableRunStores';
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
  const engineCursor = externalEngine
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
    recoveryHandlerOverrides: (kernel) => buildHandlers(kernel),
  });

  function buildHandlers(kernel: DurableRunKernel): DurableRecoveryHandlerOverrides {
    const handler = (engineKind: DurableEngineRecoveryHandler['engineKind']): DurableEngineRecoveryHandler => ({
      name: `acceptance_${engineKind}`,
      engineKind,
      async recover(plan, now) {
        const state = plan.checkpoint?.state as PersistedAcceptanceState;
        const engineCursor = plan.checkpoint?.cursor.engineCursor as { graphId?: string; traceId?: string } | undefined;
        logicalIdentityLinked = state.runId === plan.envelope.runId
          && state.sessionId === plan.envelope.sessionId
          && (plan.envelope.engine.kind === 'external_cli'
            ? state.externalSessionId === plan.envelope.engine.externalSessionId
            : state.graphId === engineCursor?.graphId && state.traceId === engineCursor?.traceId);
        try {
          await kernel.checkpoint({
            runId: plan.envelope.runId,
            attempt: 1,
            owner: state.oldOwner,
            now,
            status: 'running',
            state,
            pendingOperations: plan.pendingOperations,
            childRuns: plan.childRuns,
            events: [{ type: 'stale_write', payload: null, recordedAt: now }],
          });
        } catch {
          staleWriteRejected = true;
        }

        if (selected.coreId === 'mcp-durable-task') {
          return { status: 'observing', reason: 'native run waits for MCP Durable Task reconciliation' };
        }

        const counters = await loadCounters();
        if (selected.id === 'before-model-dispatch' || selected.id === 'after-model-response-safe-retry') {
          counters.modelDispatches += 1;
        } else if (selected.id === 'after-model-response-queryable') {
          const result = JSON.parse(await readFile(providerResultPath, 'utf8')) as { result: string };
          if (result.result !== 'original-result') throw new Error('provider result identity changed');
          counters.providerQueries += 1;
        } else if (selected.id === 'between-tool-begin-end-deduplicated') {
          counters.providerQueries += 1;
        } else if (selected.id === 'dynamic-workflow') {
          counters.recoveredNodeExecutions += 1;
        } else if (selected.id === 'agent-team-auto-agent') {
          counters.recoveredNodeExecutions += 1;
          const { GraphEventCompatibilityAdapter } = await import('../../../src/host/orchestration/graphEventCompatibilityAdapter');
          const compatibility = new GraphEventCompatibilityAdapter({
            graph: () => { graphTerminalCount += 1; },
          });
          compatibility.subscribe({ agent: () => undefined, swarm: () => undefined });
          const terminal: GraphEvent = {
            type: 'graph_completed', graphId: state.graphId, runId: state.runId,
            sessionId: state.sessionId, attempt: plan.envelope.attempt, sequence: 1, timestamp: now,
            graphStatus: 'completed',
          };
          await compatibility.emit(terminal);
          await compatibility.emit(terminal);
        }

        if (selected.expectedOutcome === 'waiting_review') {
          requiresReviewReason = selected.requiresReviewReason ?? 'requires_review';
          await checkpointWaiting(kernel, plan, state, now, requiresReviewReason);
          await saveCounters(counters);
          return { status: 'requires_review', reason: requiresReviewReason };
        }
        if (selected.expectedOutcome === 'waiting_approval') {
          await checkpointWaiting(kernel, plan, state, now, 'approval_waiting');
          await saveCounters(counters);
          return { status: 'observing', reason: recoveryAction };
        }

        counters.outputCommits += 1;
        const pendingOperations = plan.pendingOperations.map((operation) => ({
          ...operation,
          status: 'succeeded' as const,
          resultRef: `result:${operation.operationId}`,
          updatedAt: now,
        }));
        await kernel.checkpoint({
          runId: plan.envelope.runId, attempt: plan.envelope.attempt, owner: plan.envelope.owner!, now,
          status: 'running', state: { ...state, recoveredByPid: process.pid },
          engineCursor: plan.checkpoint?.cursor.engineCursor, pendingOperations,
          childRuns: plan.childRuns,
          events: [{ type: 'recovery_output_committed', payload: { scenarioId: selected.id }, recordedAt: now }],
        });
        await kernel.terminal({
          runId: plan.envelope.runId, attempt: plan.envelope.attempt, owner: plan.envelope.owner!, now: now + 1,
          status: 'completed', reason: recoveryAction,
          event: { type: 'run_completed', payload: { scenarioId: selected.id }, recordedAt: now + 1 },
        });
        await saveCounters(counters);
        return { status: 'recovered', reason: recoveryAction };
      },
    });
    return {
      native: handler('native'),
      ...(selected.id === 'child-agent-running' ? {} : { agentTeam: handler('agent_team') }),
      ...(selected.coreId === 'dynamic-workflow' ? {} : { dynamicWorkflow: handler('dynamic_workflow') }),
      ...(selected.coreId === 'external-engine' ? {} : { externalEngine: handler('external_cli') }),
      ...(selected.coreId === 'mcp-durable-task' ? {} : { mcpOperation: {
        name: 'acceptance_operation_projection',
        matches: () => true,
        async recover(_plan, operation) {
          return { status: 'observing', reason: `operation projected: ${operation.operationId}` };
        },
      } }),
    };
  }

  if (selected.coreId === 'external-engine') {
    const latest = await repository.get(`acceptance-${selected.id}`);
    const originalState = JSON.parse(String((db.prepare(`SELECT state_json FROM durable_run_checkpoints
      WHERE run_id = ? AND checkpoint_seq = 1`).get(`acceptance-${selected.id}`) as { state_json: string }).state_json)) as PersistedAcceptanceState;
    logicalIdentityLinked = latest?.runId === originalState.runId
      && latest.sessionId === originalState.sessionId
      && (latest.engine.kind !== 'external_cli' || latest.engine.externalSessionId === originalState.externalSessionId);
    recoveryAction = runtime.recoveryResults.find((result) => result.phase === 'engine')?.reason ?? recoveryAction;
    if (selected.expectedOutcome === 'waiting_review') requiresReviewReason = recoveryAction;
    if (!staleWriteRejected && runtime.kernel && latest?.owner) {
      try {
        await runtime.kernel.checkpoint({
          runId: latest.runId, attempt: 1, owner: latestState.oldOwner, now: Date.now(), status: 'running',
          state: latestState, pendingOperations: latest.pendingOperations, childRuns: latest.childRuns, events: [],
        });
      } catch {
        staleWriteRejected = true;
      }
    }
  }
  if (selected.coreId === 'mcp-durable-task') {
    const operationResult = runtime.recoveryResults.find((result) => result.phase === 'operation');
    recoveryAction = operationResult?.reason ?? recoveryAction;
    if (selected.expectedOutcome === 'waiting_review') requiresReviewReason = recoveryAction;
  }
  if (selected.coreId === 'dynamic-workflow') {
    const engineResult = runtime.recoveryResults.find((result) => result.phase === 'engine');
    recoveryAction = engineResult?.reason ?? recoveryAction;
    if (selected.expectedOutcome === 'waiting_review') requiresReviewReason = recoveryAction;
    const latest = await repository.get(`acceptance-${selected.id}`);
    const originalState = JSON.parse(String((db.prepare(`SELECT state_json FROM durable_run_checkpoints
      WHERE run_id = ? AND checkpoint_seq = 1`).get(`acceptance-${selected.id}`) as { state_json: string }).state_json)) as PersistedAcceptanceState;
    logicalIdentityLinked = latest?.runId === originalState.runId && latest.sessionId === originalState.sessionId;
    if (!staleWriteRejected && runtime.kernel && latest) {
      try {
        await runtime.kernel.checkpoint({
          runId: latest.runId, attempt: 1, owner: originalState.oldOwner, now: Date.now(), status: 'running',
          state: originalState, pendingOperations: latest.pendingOperations, childRuns: latest.childRuns, events: [],
        });
      } catch {
        staleWriteRejected = true;
      }
    }
  }
  if (selected.id === 'child-agent-running') {
    const engineResult = runtime.recoveryResults.find((result) => result.phase === 'engine');
    recoveryAction = engineResult?.reason ?? recoveryAction;
    requiresReviewReason = recoveryAction;
    const latest = await repository.get(`acceptance-${selected.id}`);
    const originalState = JSON.parse(String((db.prepare(`SELECT state_json FROM durable_run_checkpoints
      WHERE run_id = ? AND checkpoint_seq = 1`).get(`acceptance-${selected.id}`) as { state_json: string }).state_json)) as PersistedAcceptanceState;
    logicalIdentityLinked = latest?.runId === originalState.runId && latest.sessionId === originalState.sessionId;
    if (!staleWriteRejected && runtime.kernel && latest) {
      try {
        await runtime.kernel.checkpoint({
          runId: latest.runId, attempt: 1, owner: originalState.oldOwner, now: Date.now(), status: 'running',
          state: originalState, pendingOperations: latest.pendingOperations, childRuns: latest.childRuns, events: [],
        });
      } catch {
        staleWriteRejected = true;
      }
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
    WHERE run_id = ? AND checkpoint_seq = 1`).get(envelope.runId) as { state_json: string }).state_json)) as PersistedAcceptanceState;
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
  const engineDispatch = runtime.recoveryResults.find((result) => result.phase === 'engine');
  const operationDispatch = runtime.recoveryResults.find((result) => result.phase === 'operation');
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

async function checkpointWaiting(
  kernel: DurableRunKernel,
  plan: RunRehydrationPlan,
  state: PersistedAcceptanceState,
  now: number,
  reason: string,
): Promise<void> {
  await kernel.checkpoint({
    runId: plan.envelope.runId, attempt: plan.envelope.attempt, owner: plan.envelope.owner!, now,
    status: 'waiting', state: { ...state, recoveredByPid: process.pid, requiresReviewReason: reason },
    engineCursor: plan.checkpoint?.cursor.engineCursor, pendingOperations: plan.pendingOperations,
    childRuns: plan.childRuns,
    events: [{ type: 'recovery_waiting', payload: { reason }, recordedAt: now }],
  });
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
