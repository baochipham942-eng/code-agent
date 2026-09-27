import {
  createRunContext,
  createRunHandle,
  type CreateRunContextInput,
  type RunHandle,
} from './runContext';
import {
  addChildRunRef,
  createChildRunRef,
  isTerminalRunStatus,
  projectChildRunTerminal,
  type PendingOperation,
  type RunEnvelope,
  type RunOwnerLease,
} from '../../shared/contract/durableRun';
import type { ExternalAgentEngineKind } from '../../shared/contract/agentEngine';
import type {
  DurableCheckpointInput,
  DurableTerminalInput,
  RunKernelAdapter,
} from './durableRunKernel';
import type { RunRehydrationPlan } from './durableRunStores';
import {
  createRunTraceContext,
  type RunTraceContext,
} from '../telemetry/runTraceContext';
import { getTelemetryService } from '../telemetry/telemetryService';
import {
  AgentTeamDurableRuntime,
  configureAgentTeamDurableRuntime,
} from '../agent/agentTeamDurableAdapter';
import {
  BackgroundSubagentDurableLedger,
  configureBackgroundSubagentDurableLedger,
} from '../agent/backgroundSubagentDurableLedger';
import type {
  AgentTeamDurableParentHost,
  AgentTeamParentProjectionInput,
  AgentTeamParentTerminalInput,
} from '../agent/agentTeamDurableTypes';
import {
  AutoAgentDurableRuntime,
  configureAutoAgentDurableRuntime,
} from '../agent/autoAgentDurableRuntime';
import {
  LoopDurableLedger,
  configureLoopDurableLedger,
} from '../loop/loopDurableLedger';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isNativeRecoveryDescriptor, type NativeRecoveryDescriptor } from './nativeRecoveryHost';
import type { ConversationModelSpec } from '../../shared/contract/conversationEnvelope';
import { createKeyedSerializer } from './keyedSerializer';
import { findRecoveredWaitingRun as matchRecoveredWaitingRun } from './recoveredWaitingRun';
import {
  asNativeAgentTeamProjectionState,
  isDurableActiveSessionConstraint,
  isHeartbeatFencingError,
  isSqliteBusyError,
  mergeAgentTeamProjectionState,
} from './runRegistrySupport';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('RunRegistry');

const HEARTBEAT_TRANSIENT_RETRY_WINDOWS = 2;

export class RunSessionConflictError extends Error {
  readonly code = 'RUN_SESSION_CONFLICT';

  constructor(
    readonly sessionId: string,
    readonly existingRunId?: string,
    options?: ErrorOptions,
  ) {
    super(existingRunId
      ? `Session ${sessionId} already has active run ${existingRunId}`
      : `Session ${sessionId} already has an active durable run`, options);
    this.name = 'RunSessionConflictError';
  }
}

export interface RunSelector {
  runId?: string;
  sessionId?: string;
}

export interface ExternalDurableRunStart {
  handle: RunHandle;
  launchOperation: PendingOperation;
}

export class RunRegistry implements AgentTeamDurableParentHost {
  private readonly handlesByRunId = new Map<string, RunHandle>();
  private readonly runIdBySessionId = new Map<string, string>();
  private readonly durableOwners = new Map<string, { owner: RunOwnerLease; attempt: number }>();
  private readonly durableTraceContexts = new Map<string, RunTraceContext>();
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly durableEnvelopes = new Map<string, RunEnvelope>();
  private readonly durableCheckpointStates = new Map<string, unknown>();
  private readonly modelSpecsByRunId = new Map<string, ConversationModelSpec>();
  private readonly recoveredWaitingCancels = new Map<string, Promise<{ runId: string; sessionId: string }>>();
  private readonly serializeDurableMutation = createKeyedSerializer();
  private kernel: RunKernelAdapter | null = null;

  configureDurableKernel(kernel: RunKernelAdapter): void {
    this.kernel = kernel;
    configureAgentTeamDurableRuntime(new AgentTeamDurableRuntime(kernel, this));
    configureAutoAgentDurableRuntime(new AutoAgentDurableRuntime(kernel, this));
    configureBackgroundSubagentDurableLedger(new BackgroundSubagentDurableLedger(kernel));
    configureLoopDurableLedger(new LoopDurableLedger(kernel));
  }

  /** Durable kernel 是启动后异步配置的（冷启实测约 13s）；硬依赖 durable 的入口先等它就绪再决定成败。 */
  async waitForDurableKernel(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.kernel && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return this.kernel !== null;
  }

  start(input: CreateRunContextInput): RunHandle {
    const context = createRunContext(input);
    const handle = createRunHandle(context);
    this.register(handle);
    return handle;
  }

  /**
   * Register a lightweight, non-durable owner without replacing the conversation's
   * primary run index. Auxiliary runs are still full RunHandles and therefore pass
   * runId + sessionId ownership checks, but getBySessionId() keeps resolving the
   * agent/model run that owns conversation controls.
   */
  startAuxiliary(input: CreateRunContextInput): RunHandle {
    const context = createRunContext(input);
    const handle = createRunHandle(context);
    this.registerHandle(handle, false);
    return handle;
  }

  /**
   * Start a durable native child without replacing the session's foreground control owner.
   * The child run id is also the command-center task id, so UI, task control and durable
   * persistence can be joined without heuristics.
   */
  async startAuxiliaryDurableChild(
    input: CreateRunContextInput,
    parentRunId: string,
    now = Date.now(),
  ): Promise<RunHandle> {
    const context = createRunContext(input);
    await this.prepareAgentTeamChild({
      parentRunId,
      teamRunId: context.runId,
      treeId: context.runId,
      logicalOperationId: context.runId,
      sideEffect: true,
      now,
      initialStatus: 'running',
    });
    let created;
    try {
      created = await this.requireKernel().createNativeRun({
        runId: context.runId,
        sessionId: context.sessionId,
        parentRunId,
        now,
      });
      await this.projectAuxiliaryChildAccepted(parentRunId, context.runId, now);
    } catch (error) {
      await this.projectAgentTeamChildTerminal({
        parentRunId,
        teamRunId: context.runId,
        status: 'failed',
        resultRef: `auxiliary-child:${context.runId}:start-failed`,
        now,
      }).catch(() => undefined);
      throw error;
    }
    const traceContext = createRunTraceContext({
      runId: context.runId,
      sessionId: context.sessionId,
      attempt: created.attempt.attempt,
      ownerEpoch: created.owner.epoch,
      engine: created.envelope.engine.kind,
      workspace: context.workspace,
      parentRunId,
      processInstanceId: created.owner.processInstanceId,
    });
    const handle = createRunHandle(context, traceContext);
    this.registerHandle(handle, false);
    this.durableOwners.set(context.runId, { owner: created.owner, attempt: created.attempt.attempt });
    this.durableEnvelopes.set(context.runId, created.envelope);
    this.durableTraceContexts.set(context.runId, traceContext);
    this.startAttemptSpan(traceContext, { 'run.parent_id': parentRunId, 'run.auxiliary': true });
    this.startHeartbeat(context.runId, created.owner, now);
    return handle;
  }

  private async projectAuxiliaryChildAccepted(
    parentRunId: string,
    childRunId: string,
    now: number,
  ): Promise<void> {
    return this.serializeDurableMutation(parentRunId, async () => {
    const envelope = this.durableEnvelopes.get(parentRunId);
    if (!envelope) throw new Error(`Native parent projection unavailable: ${parentRunId}`);
    const operationId = `agent-team:${childRunId}`;
    const pendingOperations = (envelope.pendingOperations ?? []).map((operation) => (
      operation.operationId === operationId
        ? {
            ...operation,
            status: 'succeeded' as const,
            resultRef: `auxiliary-child:${childRunId}:accepted`,
            updatedAt: now,
          }
        : operation
    ));
    const previousState = this.durableCheckpointStates.get(parentRunId);
    await this.checkpointDurable(parentRunId, {
      now,
      status: envelope.status === 'waiting' || envelope.status === 'paused' || envelope.status === 'recovering'
        ? envelope.status
        : 'running',
      state: mergeAgentTeamProjectionState(previousState, {
        teamRunId: childRunId,
        treeId: childRunId,
        operationId,
        status: 'accepted',
        resultRef: `auxiliary-child:${childRunId}:accepted`,
      }),
      pendingOperations,
      childRuns: envelope.childRuns,
      events: [{
        type: 'auxiliary_child_accepted',
        payload: { childRunId, operationId },
        recordedAt: now,
      }],
    });
    });
  }

  /** Durable Native entry point. Existing synchronous start() remains for compatibility callers. */
  async startDurable(input: CreateRunContextInput, now = Date.now()): Promise<RunHandle> {
    const kernel = this.requireKernel();
    const context = createRunContext(input);
    const existingRunId = this.runIdBySessionId.get(context.sessionId);
    if (existingRunId && existingRunId !== context.runId) {
      throw new RunSessionConflictError(context.sessionId, existingRunId);
    }
    const created = await this.createWithSessionConflictMapping(
      context.sessionId,
      () => kernel.createNativeRun({
        runId: context.runId,
        sessionId: context.sessionId,
        now,
      }),
    );
    const traceContext = createRunTraceContext({
      runId: context.runId,
      sessionId: context.sessionId,
      attempt: created.attempt.attempt,
      ownerEpoch: created.owner.epoch,
      engine: created.envelope.engine.kind,
      workspace: context.workspace,
      parentRunId: created.envelope.parentRunId,
      processInstanceId: created.owner.processInstanceId,
    });
    const handle = createRunHandle(context, traceContext);
    this.register(handle);
    this.durableOwners.set(context.runId, { owner: created.owner, attempt: created.attempt.attempt });
    this.durableEnvelopes.set(context.runId, created.envelope);
    this.durableTraceContexts.set(context.runId, traceContext);
    this.startAttemptSpan(traceContext);
    this.startHeartbeat(context.runId, created.owner, now);
    return handle;
  }

  async startExternalDurable(
    input: CreateRunContextInput & {
      engine: ExternalAgentEngineKind;
      externalSessionId?: string;
      resumeCapable?: boolean;
    },
    now = Date.now(),
  ): Promise<ExternalDurableRunStart> {
    const kernel = this.requireKernel();
    const context = createRunContext(input);
    const existingRunId = this.runIdBySessionId.get(context.sessionId);
    if (existingRunId && existingRunId !== context.runId) {
      throw new RunSessionConflictError(context.sessionId, existingRunId);
    }
    const launchOperation = kernel.prepareOperation({
      runId: context.runId,
      operationId: 'external-engine-launch',
      logicalOperationId: 'external-engine-launch',
      attempt: 1,
      kind: 'external_engine',
      sideEffect: true,
      canDeduplicate: input.resumeCapable === true && Boolean(input.externalSessionId),
      now,
      providerOperationId: input.resumeCapable && input.externalSessionId
        ? `external-session:${input.externalSessionId}`
        : undefined,
    });
    const created = await this.createWithSessionConflictMapping(
      context.sessionId,
      () => kernel.createRun({
        runId: context.runId,
        sessionId: context.sessionId,
        engine: {
          kind: 'external_cli',
          engine: input.engine,
          ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
        },
        now,
        initialEngineCursor: {
          schemaVersion: 1,
          engine: input.engine,
          externalSessionId: input.externalSessionId,
        },
        initialPendingOperations: [launchOperation],
      }),
    );
    const traceContext = createRunTraceContext({
      runId: context.runId,
      sessionId: context.sessionId,
      attempt: created.attempt.attempt,
      ownerEpoch: created.owner.epoch,
      engine: input.engine,
      workspace: context.workspace,
      processInstanceId: created.owner.processInstanceId,
    });
    const handle = createRunHandle(context, traceContext);
    this.register(handle);
    this.durableOwners.set(context.runId, { owner: created.owner, attempt: created.attempt.attempt });
    this.durableEnvelopes.set(context.runId, created.envelope);
    this.durableTraceContexts.set(context.runId, traceContext);
    this.startAttemptSpan(traceContext, { 'run.external_engine': input.engine });
    this.startHeartbeat(context.runId, created.owner, now);
    return { handle, launchOperation };
  }

  async heartbeatDurable(runId: string, now = Date.now()): Promise<RunOwnerLease> {
    const live = this.requireDurableOwner(runId);
    const owner = await this.requireKernel().heartbeat(runId, live.owner, now);
    this.durableOwners.set(runId, { ...live, owner });
    return owner;
  }

  async checkpointDurable(
    runId: string,
    input: Omit<DurableCheckpointInput, 'runId' | 'attempt' | 'owner'>,
  ) {
    return this.serializeDurableMutation(runId, async () => {
      const live = this.requireDurableOwner(runId);
      const checkpoint = await this.requireKernel().checkpoint({
        ...input,
        runId,
        attempt: live.attempt,
        owner: live.owner,
      });
      const envelope = this.durableEnvelopes.get(runId);
      if (envelope) {
        this.durableEnvelopes.set(runId, {
          ...envelope,
          status: input.status,
          attempt: live.attempt,
          cursor: checkpoint.cursor,
          owner: live.owner,
          pendingOperations: input.pendingOperations,
          childRuns: input.childRuns ?? envelope.childRuns,
          updatedAt: input.now,
        });
      }
      this.durableCheckpointStates.set(runId, input.state);
      return checkpoint;
    });
  }

  async checkpointNativeModelOperation(input: {
    runId: string;
    sourceMessageId: string;
    provider: string;
    model: string;
    logicalOperationId: string;
    phase: NativeRecoveryDescriptor['phase'];
    status: PendingOperation['status'];
    resultRef?: string;
    isGoalRun?: boolean;
    now?: number;
  }): Promise<void> {
    return this.serializeDurableMutation(input.runId, async () => {
    const now = input.now ?? Date.now();
    const live = this.requireDurableOwner(input.runId);
    const envelope = this.durableEnvelopes.get(input.runId);
    const handle = this.handlesByRunId.get(input.runId);
    if (!envelope || !handle) throw new Error(`Native Durable Run ${input.runId} is not active`);
    const operationId = `model:${input.logicalOperationId}`;
    const existing = envelope.pendingOperations?.find((operation) => operation.operationId === operationId);
    const prepared = existing ?? this.requireKernel().prepareOperation({
      runId: input.runId,
      operationId,
      logicalOperationId: input.logicalOperationId,
      attempt: live.attempt,
      kind: 'model_call',
      sideEffect: false,
      canDeduplicate: false,
      now,
    });
    const operation: PendingOperation = {
      ...prepared,
      status: input.status,
      ...(input.resultRef ? { resultRef: input.resultRef } : {}),
      updatedAt: now,
    };
    const pendingOperations = [
      ...(envelope.pendingOperations ?? []).filter((candidate) => candidate.operationId !== operationId),
      operation,
    ];
    const workspace = path.resolve(handle.context.workspace);
    const cwd = path.resolve(handle.context.cwd);
    const descriptor: NativeRecoveryDescriptor = {
      schemaVersion: 1,
      kind: 'native',
      sourceMessageId: input.sourceMessageId,
      provider: input.provider,
      model: input.model,
      workspace: {
        root: workspace,
        cwd,
        fingerprint: createHash('sha256').update(workspace).digest('hex'),
        scope: handle.context.workspaceScope,
      },
      logicalOperationId: input.logicalOperationId,
      operationId,
      phase: input.phase,
      checkpointSequence: envelope.cursor.checkpointSeq + 1,
      ...(input.isGoalRun ? { isGoalRun: true } : {}),
    };
    await this.checkpointDurable(input.runId, {
      now,
      status: 'running',
      state: descriptor,
      engineCursor: { schemaVersion: 1, runtime: 'native', operationId, phase: input.phase },
      pendingOperations,
      childRuns: envelope.childRuns,
      events: [{ type: 'native_model_operation', payload: { operationId, phase: input.phase, status: input.status }, recordedAt: now }],
    });
    });
  }

  async checkpointNativeToolOperation(input: {
    runId: string;
    sourceMessageId: string;
    toolName: string;
    logicalOperationId: string;
    providerOperationId: string;
    sideEffect: boolean;
    status: PendingOperation['status'];
    resultRef?: string;
    now?: number;
  }): Promise<void> {
    return this.serializeDurableMutation(input.runId, async () => {
    const now = input.now ?? Date.now();
    const live = this.requireDurableOwner(input.runId);
    const envelope = this.durableEnvelopes.get(input.runId);
    const handle = this.handlesByRunId.get(input.runId);
    if (!envelope || !handle) throw new Error(`Native Durable Run ${input.runId} is not active`);
    const operationId = `tool:${input.logicalOperationId}`;
    const existing = envelope.pendingOperations?.find((operation) => operation.operationId === operationId);
    const prepared = existing ?? this.requireKernel().prepareOperation({
      runId: input.runId,
      operationId,
      logicalOperationId: input.logicalOperationId,
      attempt: live.attempt,
      kind: 'tool_call',
      sideEffect: input.sideEffect,
      canDeduplicate: true,
      providerOperationId: input.providerOperationId,
      now,
    });
    const operation: PendingOperation = {
      ...prepared,
      status: input.status,
      providerOperationId: input.providerOperationId,
      ...(input.resultRef ? { resultRef: input.resultRef } : {}),
      updatedAt: now,
    };
    const pendingOperations = [
      ...(envelope.pendingOperations ?? []).filter((candidate) => candidate.operationId !== operationId),
      operation,
    ];
    const workspace = path.resolve(handle.context.workspace);
    const descriptor: NativeRecoveryDescriptor = {
      schemaVersion: 1,
      kind: 'native',
      sourceMessageId: input.sourceMessageId,
      provider: 'tool',
      model: input.toolName,
      workspace: {
        root: workspace,
        cwd: path.resolve(handle.context.cwd),
        fingerprint: createHash('sha256').update(workspace).digest('hex'),
        scope: handle.context.workspaceScope,
      },
      logicalOperationId: input.logicalOperationId,
      operationId,
      phase: 'tool_dispatched',
      checkpointSequence: envelope.cursor.checkpointSeq + 1,
    };
    await this.checkpointDurable(input.runId, {
      now,
      status: 'running',
      state: descriptor,
      engineCursor: { schemaVersion: 1, runtime: 'native', operationId, phase: 'tool_dispatched' },
      pendingOperations,
      childRuns: envelope.childRuns,
      events: [{ type: 'native_tool_operation', payload: { operationId, status: input.status }, recordedAt: now }],
    });
    });
  }

  async prepareAgentTeamChild(input: AgentTeamParentProjectionInput): Promise<void> {
    return this.serializeDurableMutation(input.parentRunId, async () => {
    const live = this.requireDurableOwner(input.parentRunId);
    const envelope = this.durableEnvelopes.get(input.parentRunId);
    if (!envelope) throw new Error(`Native parent projection unavailable: ${input.parentRunId}`);
    const operationId = `agent-team:${input.logicalOperationId}`;
    const existingOperation = envelope.pendingOperations?.find((operation) => operation.operationId === operationId);
    const operation = existingOperation ?? this.requireKernel().prepareOperation({
      runId: input.parentRunId,
      operationId,
      logicalOperationId: input.logicalOperationId,
      attempt: live.attempt,
      kind: 'child_run',
      sideEffect: input.sideEffect,
      canDeduplicate: false,
      now: input.now,
    });
    const child = createChildRunRef({
      parentRunId: input.parentRunId,
      childRunId: input.teamRunId,
      relation: 'agent',
      now: input.now,
      initialStatus: input.initialStatus,
    });
    const pendingOperations = existingOperation
      ? [...(envelope.pendingOperations ?? [])]
      : [...(envelope.pendingOperations ?? []), operation];
    const childRuns = addChildRunRef([...(envelope.childRuns ?? [])], child);
    const previousState = this.durableCheckpointStates.get(input.parentRunId);
    await this.checkpointDurable(input.parentRunId, {
      now: input.now,
      status: envelope.status === 'waiting' || envelope.status === 'paused' || envelope.status === 'recovering'
        ? envelope.status
        : 'running',
      state: mergeAgentTeamProjectionState(previousState, {
        teamRunId: input.teamRunId,
        treeId: input.treeId,
        operationId,
        status: 'prepared',
      }),
      pendingOperations,
      childRuns,
      events: [{
        type: 'child_run_prepared',
        payload: { childRunId: input.teamRunId, treeId: input.treeId, operationId },
        recordedAt: input.now,
      }],
    });
    });
  }

  async projectAgentTeamChildTerminal(input: AgentTeamParentTerminalInput): Promise<void> {
    return this.serializeDurableMutation(input.parentRunId, async () => {
    const envelope = this.durableEnvelopes.get(input.parentRunId);
    if (!envelope) throw new Error(`Native parent projection unavailable: ${input.parentRunId}`);
    const projected = projectChildRunTerminal(envelope, {
      childRunId: input.teamRunId,
      status: input.status,
      terminalAt: input.now,
    });
    const previousState = this.durableCheckpointStates.get(input.parentRunId);
    const previousProjection = asNativeAgentTeamProjectionState(previousState);
    const teamProjection = previousProjection?.teams.find((team) => team.teamRunId === input.teamRunId);
    const pendingOperations: PendingOperation[] = (projected.pendingOperations ?? []).map((operation) =>
      operation.kind === 'child_run' && operation.operationId === teamProjection?.operationId
        ? {
            ...operation,
            status: input.status === 'completed' ? 'succeeded' : 'failed',
            resultRef: input.resultRef,
            updatedAt: input.now,
          }
        : operation);
    await this.checkpointDurable(input.parentRunId, {
      now: input.now,
      status: envelope.status === 'waiting' || envelope.status === 'paused' || envelope.status === 'recovering'
        ? envelope.status
        : 'running',
      state: mergeAgentTeamProjectionState(previousState, {
        teamRunId: input.teamRunId,
        treeId: teamProjection?.treeId ?? input.teamRunId,
        operationId: teamProjection?.operationId ?? '',
        status: input.status,
        resultRef: input.resultRef,
      }),
      pendingOperations,
      childRuns: projected.childRuns,
      events: [{
        type: 'child_run_terminal',
        payload: { childRunId: input.teamRunId, status: input.status, resultRef: input.resultRef },
        recordedAt: input.now,
      }],
    });
    });
  }

  async terminalDurable(
    runId: string,
    input: Omit<DurableTerminalInput, 'runId' | 'attempt' | 'owner'>,
    expected?: RunHandle,
  ) {
    return this.serializeDurableMutation(runId, async () => {
      if (expected && this.handlesByRunId.get(runId) !== expected) {
        throw new Error(`Durable Run terminal fenced by stale handle: ${runId}`);
      }
      const live = this.requireDurableOwner(runId);
      const envelope = await this.requireKernel().terminal({
        ...input,
        runId,
        attempt: live.attempt,
        owner: live.owner,
      });
      this.durableOwners.delete(runId);
      this.durableEnvelopes.delete(runId);
      this.durableCheckpointStates.delete(runId);
      this.stopHeartbeat(runId);
      this.endAttemptSpan(runId, input.status === 'completed' ? 'ok' : input.status === 'cancelled' ? 'cancelled' : 'error', {
        'terminal.status': input.status,
      });
      this.unregister(runId, expected);
      return envelope;
    });
  }

  async cancelOrphanedSessionRoot(input: {
    sessionId: string;
    expectedOwnerId: string;
    processInstanceId: string;
    now?: number;
  }): Promise<boolean> {
    const kernel = this.requireKernel();
    if (await this.terminalSelfOwnedUnadoptedSessionRoot(input)) return true;
    return kernel.cancelOrphanedSessionRoot
      ? kernel.cancelOrphanedSessionRoot(input)
      : false;
  }

  /**
   * 本进程启动恢复（recoverDurable / 清扫器）认领后没有任何活 handle 领养的主 run：
   * owner 已是本进程，跨进程僵尸判据（pid 探测 / 租约过期）必然拒收，但没有任何东西
   * 在驱动它——对新一轮 `-s` 续跑等同于僵尸。沿 terminalDurable 规范路径（owner/attempt
   * fence + 事件序号）收尸。有 handle 的（本进程真在跑的 run）不碰，保持原冲突语义。
   * waiting / paused 有明确业务语义（待人工复核 / 待审批），归桌面复核收件箱与显式
   * 取消路径（terminalRecoveredWaitingRun）管，CLI 续跑不替人做决定。
   * 只收 native 引擎：loop / agent_team 等引擎的 recovery driver（LoopController.adopt、
   * 各自账本）不注册 RunHandle 却仍在驱动 run，「无 handle」对它们不等于「无驱动」。
   */
  private async terminalSelfOwnedUnadoptedSessionRoot(input: {
    sessionId: string;
    expectedOwnerId: string;
    processInstanceId: string;
    now?: number;
  }): Promise<boolean> {
    const kernel = this.requireKernel();
    if (typeof kernel.getLatestActiveRootBySession !== 'function') return false;
    const now = input.now ?? Date.now();
    const latest = await kernel.getLatestActiveRootBySession(input.sessionId).catch(() => null);
    if (!latest || isTerminalRunStatus(latest.status) || latest.parentRunId) return false;
    if (latest.status === 'waiting' || latest.status === 'paused') return false;
    if (latest.engine.kind !== 'native') return false;
    const owner = latest.owner;
    if (owner?.ownerId !== input.expectedOwnerId) return false;
    if (owner.processInstanceId !== input.processInstanceId) return false;
    if (this.handlesByRunId.has(latest.runId)) return false;
    if (!this.durableOwners.has(latest.runId)) return false;
    logger.warn('Reaping self-owned durable run orphan before session resume', {
      sessionId: input.sessionId,
      runId: latest.runId,
      status: latest.status,
      attempt: latest.attempt,
      ownerEpoch: owner.epoch,
    });
    try {
      await this.terminalDurable(latest.runId, {
        now,
        status: 'cancelled',
        reason: 'cli_resume_reaped_recovered_orphan',
        event: {
          type: 'run_cancelled',
          payload: { sessionId: input.sessionId, reason: 'cli_resume_reaped_recovered_orphan' },
          recordedAt: now,
        },
      });
      return true;
    } catch (error) {
      logger.warn('Failed to reap self-owned durable run orphan', {
        sessionId: input.sessionId,
        runId: latest.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async releaseDurable(runId: string, expected?: RunHandle, now = Date.now()): Promise<boolean> {
    if (expected && this.handlesByRunId.get(runId) !== expected) return false;
    const live = this.durableOwners.get(runId);
    if (!live) return false;
    const released = await this.requireKernel().release(runId, live.owner, now);
    if (released) {
      this.durableOwners.delete(runId);
      this.durableEnvelopes.delete(runId);
      this.durableCheckpointStates.delete(runId);
      this.stopHeartbeat(runId);
      this.unregister(runId, expected);
      this.endAttemptSpan(runId, 'cancelled', { 'terminal.status': 'released' });
    }
    return released;
  }

  findRecoveredWaitingRun(selector: { runId?: string; sessionId?: string }): { runId: string; sessionId: string } | undefined {
    return matchRecoveredWaitingRun(
      this.durableEnvelopes.values(),
      (runId) => this.handlesByRunId.has(runId),
      (runId) => this.durableOwners.has(runId),
      selector,
    );
  }

  /** 把 findRecoveredWaitingRun 命中的 run 沿 terminalDurable 规范路径（owner/attempt fence + 事件序号）终态化成 cancelled。 */
  async terminalRecoveredWaitingRun(
    selector: { runId?: string; sessionId?: string },
    now = Date.now(),
  ): Promise<{ runId: string; sessionId: string; joined?: true } | undefined> {
    const recovered = this.findRecoveredWaitingRun(selector);
    if (!recovered) return undefined;
    // 桌面「放弃」与手机「停止」可能同时到：两边都在终态提交前查到了它。后到的一方
    // 并到同一次提交上，而不是再提交一次撞 cancelled -> cancelled 冲突抛错（桌面 500）。
    // joined 标给后到者：终态事件只由真正提交的一方补发，手机不会收两条 agent_cancelled。
    const inFlight = this.recoveredWaitingCancels.get(recovered.runId);
    if (inFlight) return inFlight.then((settled) => ({ ...settled, joined: true as const }));
    const cancel = this.terminalDurable(recovered.runId, {
      now,
      status: 'cancelled',
      reason: 'recovered_waiting_run_cancelled',
      event: {
        type: 'run_cancelled',
        payload: { sessionId: recovered.sessionId, reason: 'recovered_waiting_run_cancelled' },
        recordedAt: now,
      },
    }).then(() => recovered).finally(() => {
      this.recoveredWaitingCancels.delete(recovered.runId);
    });
    this.recoveredWaitingCancels.set(recovered.runId, cancel);
    return cancel;
  }

  async recoverDurable(now = Date.now()): Promise<RunRehydrationPlan[]> {
    const plans = await this.requireKernel().recoverOnStartup(now);
    for (const plan of plans) {
      const owner = plan.envelope.owner;
      if (owner) {
        const previousTraceContext = this.durableTraceContexts.get(plan.envelope.runId);
        if (previousTraceContext) {
          this.endAttemptSpan(plan.envelope.runId, 'error', { 'terminal.status': 'recovering' });
        }
        const staleHandle = this.handlesByRunId.get(plan.envelope.runId);
        if (staleHandle) this.unregister(plan.envelope.runId, staleHandle);
        const traceContext = createRunTraceContext({
          runId: plan.envelope.runId,
          sessionId: plan.envelope.sessionId,
          attempt: plan.envelope.attempt,
          ownerEpoch: owner.epoch,
          engine: plan.envelope.engine.kind,
          workspaceFingerprint: previousTraceContext?.workspaceFingerprint,
          parentRunId: plan.envelope.parentRunId,
          processInstanceId: owner.processInstanceId,
        });
        this.durableOwners.set(plan.envelope.runId, { owner, attempt: plan.envelope.attempt });
        this.durableEnvelopes.set(plan.envelope.runId, plan.envelope);
        this.durableCheckpointStates.set(plan.envelope.runId, plan.checkpoint?.state);
        this.durableTraceContexts.set(plan.envelope.runId, traceContext);
        this.startAttemptSpan(traceContext, {
          'run.recovery': true,
          'run.previous_attempt': plan.previousAttempt.attempt,
          'run.checkpoint_seq': plan.checkpoint?.checkpointSeq ?? 0,
          ...(plan.previousAttempt.recoveryReason
            ? { 'run.recovery_reason': plan.previousAttempt.recoveryReason }
            : {}),
        });
        this.startHeartbeat(plan.envelope.runId, owner, now);
      }
    }
    return plans;
  }

  register(handle: RunHandle): void {
    this.registerHandle(handle, true);
  }

  private registerHandle(handle: RunHandle, indexBySession: boolean): void {
    const { runId, sessionId } = handle.context;
    const existingRun = this.handlesByRunId.get(runId);
    if (existingRun && existingRun !== handle) {
      throw new Error(`Run id already registered: ${runId}`);
    }

    if (indexBySession) {
      const existingRunId = this.runIdBySessionId.get(sessionId);
      if (existingRunId && existingRunId !== runId) {
        throw new RunSessionConflictError(sessionId, existingRunId);
      }
    }

    this.handlesByRunId.set(runId, handle);
    if (indexBySession) this.runIdBySessionId.set(sessionId, runId);
  }

  get(runId: string): RunHandle | undefined {
    return this.handlesByRunId.get(runId);
  }

  getTraceContext(runId: string): RunTraceContext | undefined {
    return this.durableTraceContexts.get(runId);
  }

  bindRecoveredHandle(plan: RunRehydrationPlan, workspace: string, cwd = workspace): RunHandle {
    const runId = plan.envelope.runId;
    const owner = plan.envelope.owner;
    const live = this.requireDurableOwner(runId);
    if (live.owner.epoch !== owner?.epoch || live.attempt !== plan.envelope.attempt) {
      throw new Error(`Durable Run ${runId} recovery handle has a stale owner or attempt`);
    }
    const existing = this.handlesByRunId.get(runId);
    if (existing) return existing;
    const recoveredDescriptor = plan.checkpoint?.state;
    const workspaceScope = isNativeRecoveryDescriptor(recoveredDescriptor)
      ? recoveredDescriptor.workspace.scope
      : undefined;
    const context = createRunContext({
      runId,
      sessionId: plan.envelope.sessionId,
      workspace,
      workspaceScope,
      cwd,
      createdAt: plan.envelope.createdAt,
    });
    const handle = createRunHandle(context, this.durableTraceContexts.get(runId));
    this.register(handle);
    return handle;
  }

  /** Bind a handle to a run already claimed by recoverDurable. No new durable row is created. */
  adoptRecoveredRun(input: CreateRunContextInput): RunHandle {
    const runId = input.runId?.trim();
    if (!runId) throw new Error('Recovered durable run adoption requires runId');
    const envelope = this.durableEnvelopes.get(runId);
    const live = this.durableOwners.get(runId);
    if (!envelope || !live) {
      throw new Error(`Recovered durable run is not claimed in this process: ${runId}`);
    }
    if (envelope.sessionId !== input.sessionId) {
      throw new RunSessionConflictError(input.sessionId, runId);
    }
    const existing = this.handlesByRunId.get(runId);
    if (existing) return existing;
    const recoveredDescriptor = this.durableCheckpointStates.get(runId);
    const workspaceScope = isNativeRecoveryDescriptor(recoveredDescriptor)
      ? recoveredDescriptor.workspace.scope
      : undefined;
    const workspace = input.workspace
      ?? (isNativeRecoveryDescriptor(recoveredDescriptor) ? recoveredDescriptor.workspace.root : undefined);
    const cwd = input.cwd
      ?? (isNativeRecoveryDescriptor(recoveredDescriptor) ? recoveredDescriptor.workspace.cwd : workspace);
    if (!workspace || !cwd) throw new Error(`Recovered durable run has no workspace: ${runId}`);
    const context = createRunContext({
      ...input,
      runId,
      workspace,
      cwd,
      workspaceScope: input.workspaceScope ?? workspaceScope,
      createdAt: envelope.createdAt,
    });
    const handle = createRunHandle(context, this.durableTraceContexts.get(runId));
    this.register(handle);
    return handle;
  }

  getBySessionId(sessionId: string): RunHandle | undefined {
    const runId = this.runIdBySessionId.get(sessionId);
    return runId ? this.handlesByRunId.get(runId) : undefined;
  }

  setModelSpec(runId: string, modelSpec: ConversationModelSpec): void {
    if (!this.handlesByRunId.has(runId)) {
      throw new Error(`Cannot set model spec for unregistered run: ${runId}`);
    }
    this.modelSpecsByRunId.set(runId, { ...modelSpec });
  }

  getModelSpecBySessionId(sessionId: string): ConversationModelSpec | undefined {
    const runId = this.runIdBySessionId.get(sessionId);
    const modelSpec = runId ? this.modelSpecsByRunId.get(runId) : undefined;
    return modelSpec ? { ...modelSpec } : undefined;
  }

  resolve(selector: RunSelector): RunHandle | undefined {
    const runId = selector.runId?.trim();
    const sessionId = selector.sessionId?.trim();
    if (runId) {
      const handle = this.get(runId);
      return handle && (!sessionId || handle.context.sessionId === sessionId) ? handle : undefined;
    }
    if (sessionId) return this.getBySessionId(sessionId);
    return this.size === 1 ? this.last() : undefined;
  }

  hasSession(sessionId: string): boolean {
    return this.runIdBySessionId.has(sessionId);
  }

  hasDurableOwner(runId: string): boolean {
    return this.durableOwners.has(runId);
  }

  last(): RunHandle | undefined {
    return [...this.handlesByRunId.values()].at(-1);
  }

  unregister(runId: string, expected?: RunHandle): boolean {
    const handle = this.handlesByRunId.get(runId);
    if (!handle || (expected && handle !== expected)) {
      return false;
    }
    this.handlesByRunId.delete(runId);
    this.modelSpecsByRunId.delete(runId);
    if (this.runIdBySessionId.get(handle.context.sessionId) === runId) {
      this.runIdBySessionId.delete(handle.context.sessionId);
    }
    return true;
  }

  clear(): void {
    for (const timer of this.heartbeatTimers.values()) clearInterval(timer);
    this.heartbeatTimers.clear();
    for (const runId of [...this.durableTraceContexts.keys()]) {
      this.endAttemptSpan(runId, 'cancelled', { 'terminal.status': 'registry_cleared' });
    }
    this.handlesByRunId.clear();
    this.runIdBySessionId.clear();
    this.modelSpecsByRunId.clear();
    this.durableOwners.clear();
    this.durableEnvelopes.clear();
    this.durableCheckpointStates.clear();
    this.durableTraceContexts.clear();
  }

  get size(): number {
    return this.handlesByRunId.size;
  }

  list(): RunHandle[] {
    return [...this.handlesByRunId.values()];
  }

  private requireKernel(): RunKernelAdapter {
    if (!this.kernel) throw new Error('Durable Run kernel is not configured');
    return this.kernel;
  }

  private async createWithSessionConflictMapping<T>(
    sessionId: string,
    create: () => Promise<T>,
  ): Promise<T> {
    try {
      return await create();
    } catch (error) {
      if (!isDurableActiveSessionConstraint(error)) throw error;
      throw new RunSessionConflictError(
        sessionId,
        this.runIdBySessionId.get(sessionId),
        { cause: error },
      );
    }
  }

  private requireDurableOwner(runId: string): { owner: RunOwnerLease; attempt: number } {
    const live = this.durableOwners.get(runId);
    if (!live) throw new Error(`Durable Run ${runId} has no live owner lease`);
    return live;
  }

  private startHeartbeat(runId: string, owner: RunOwnerLease, now: number): void {
    this.stopHeartbeat(runId);
    const intervalMs = Math.max(250, Math.floor((owner.leaseExpiresAt - now) / 3));
    let consecutiveTransientFailures = 0;
    const timer = setInterval(() => {
      void this.heartbeatDurable(runId).then(
        () => {
          consecutiveTransientFailures = 0;
        },
        async (error: unknown) => {
          if (isHeartbeatFencingError(error)) {
            await this.standDownDurableRun(runId);
            return;
          }
          if (isSqliteBusyError(error)) {
            consecutiveTransientFailures += 1;
            if (consecutiveTransientFailures <= HEARTBEAT_TRANSIENT_RETRY_WINDOWS) return;
          }
          await this.standDownDurableRun(runId);
        },
      );
    }, intervalMs);
    timer.unref?.();
    this.heartbeatTimers.set(runId, timer);
  }

  private async standDownDurableRun(runId: string): Promise<void> {
    const handle = this.handlesByRunId.get(runId);
    this.stopHeartbeat(runId);
    this.durableOwners.delete(runId);
    this.durableEnvelopes.delete(runId);
    this.durableCheckpointStates.delete(runId);
    this.endAttemptSpan(runId, 'error', { 'terminal.status': 'stale_owner' });
    this.unregister(runId, handle);
    if (handle) await handle.cancel('lease-lost' as never).catch(() => undefined);
  }

  private stopHeartbeat(runId: string): void {
    const timer = this.heartbeatTimers.get(runId);
    if (timer) clearInterval(timer);
    this.heartbeatTimers.delete(runId);
  }

  private startAttemptSpan(
    traceContext: RunTraceContext,
    attributes: Record<string, string | number | boolean> = {},
  ): void {
    try {
      getTelemetryService().startRunAttemptSpan(traceContext, attributes);
    } catch {
      // Tracing is diagnostic only and must never affect run ownership.
    }
  }

  private endAttemptSpan(
    runId: string,
    status: 'ok' | 'error' | 'cancelled',
    attributes: Record<string, string | number | boolean>,
  ): void {
    const traceContext = this.durableTraceContexts.get(runId);
    if (!traceContext) return;
    this.durableTraceContexts.delete(runId);
    try {
      const telemetry = getTelemetryService();
      telemetry.endOpenSpansForTrace(traceContext.traceId, status, traceContext.spanId);
      telemetry.endSpan(traceContext.spanId, status, attributes);
    } catch {
      // Tracing is diagnostic only and must never affect run ownership.
    }
  }
}
