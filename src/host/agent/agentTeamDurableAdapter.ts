import { createHash } from 'node:crypto';
import type { PendingOperation, RunOwnerLease } from '../../shared/contract/durableRun';
import type { RunKernelAdapter } from '../runtime/durableRunKernel';
import {
  createChildRunTraceContext,
  getActiveRunTraceContext,
  type RunTraceContext,
} from '../telemetry/runTraceContext';
import type { AgentTask, AgentTaskResult } from './parallelAgentCoordinatorTypes';
import {
  AGENT_TEAM_CHECKPOINT_SCHEMA_VERSION,
  type AgentTeamCheckpointNode,
  type AgentTeamCheckpointState,
  type AgentTeamDurableController,
  type AgentTeamDurableParentHost,
  type AgentTeamDurableRuntimePort,
  type AgentTeamDurableStartInput,
  type AgentTeamMailboxMessage,
} from './agentTeamDurableTypes';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableAgentTeamRunId(parentRunId: string, logicalOperationId: string): string {
  return `team_${digest(`agent-team:v1:${parentRunId}:${logicalOperationId}`).slice(0, 32)}`;
}

export function stableAgentTeamApprovalId(runId: string): string {
  return `launch_${digest(`agent-team-approval:v1:${runId}`).slice(0, 32)}`;
}

export function agentTeamTaskPermissionProfile(task: AgentTask): AgentTeamCheckpointNode['permissionProfile'] {
  const names = task.tools.map((tool) => tool.toLowerCase());
  if (names.some((tool) => /(browser|computer|web|fetch|http|network)/.test(tool))) return 'network';
  if (names.some((tool) => /(bash|shell|execute|command|terminal|run)/.test(tool))) return 'execute';
  if (names.some((tool) => /(write|edit|patch|delete|move|rename|create)/.test(tool))) return 'write';
  return 'readonly';
}

function resultRef(runId: string, taskId: string, result: AgentTaskResult): string {
  return `agent-team-result:${digest(JSON.stringify({ runId, taskId, success: result.success, output: result.output, error: result.error })).slice(0, 40)}`;
}

class Controller implements AgentTeamDurableController {
  readonly ownerEpoch: number;
  readonly traceContext?: RunTraceContext;
  private readonly operations = new Map<string, PendingOperation>();
  private serial: Promise<void> = Promise.resolve();
  private terminalized = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    readonly scope: AgentTeamDurableStartInput['scope'],
    private readonly parentRunId: string,
    private owner: RunOwnerLease,
    private readonly attempt: number,
    private readonly kernel: RunKernelAdapter,
    private readonly parentHost: AgentTeamDurableParentHost,
    private state: AgentTeamCheckpointState,
    traceContext?: RunTraceContext,
  ) {
    this.ownerEpoch = owner.epoch;
    this.traceContext = traceContext;
    for (const node of state.taskGraph) {
      this.operations.set(node.operationId, kernel.prepareOperation({
        runId: scope.runId,
        operationId: node.operationId,
        logicalOperationId: node.id,
        attempt,
        kind: 'child_run',
        sideEffect: node.sideEffect,
        canDeduplicate: false,
        now: state.updatedAt,
      }));
    }
    this.startHeartbeat(state.updatedAt);
  }

  getState(): AgentTeamCheckpointState {
    return structuredClone(this.state);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.serial.then(work);
    this.serial = next.catch(() => undefined);
    return next;
  }

  checkpoint(status: 'running' | 'waiting' | 'paused' | 'recovering' = 'running'): Promise<void> {
    return this.enqueue(async () => {
      if (this.terminalized) throw new Error(`Agent Team run is already terminal: ${this.scope.runId}`);
      await this.kernel.checkpoint({
        runId: this.scope.runId,
        attempt: this.attempt,
        owner: this.owner,
        now: this.state.updatedAt,
        status,
        state: this.state,
        engineCursor: {
          schemaVersion: AGENT_TEAM_CHECKPOINT_SCHEMA_VERSION,
          treeId: this.scope.treeId,
          mailboxCursor: this.state.mailbox.committedCursor,
        },
        pendingOperations: [...this.operations.values()],
        events: [{
          type: 'agent_team_checkpoint',
          payload: {
            treeId: this.scope.treeId,
            taskStatuses: this.state.taskGraph.map((node) => ({ id: node.id, status: node.status })),
            mailboxCursor: this.state.mailbox.committedCursor,
          },
          recordedAt: this.state.updatedAt,
        }],
      });
    });
  }

  async markApprovalWaiting(approvalId: string, now = Date.now()): Promise<void> {
    const operationId = `approval:${approvalId}`;
    this.operations.set(operationId, this.kernel.prepareOperation({
      runId: this.scope.runId,
      operationId,
      logicalOperationId: approvalId,
      attempt: this.attempt,
      kind: 'approval',
      sideEffect: false,
      canDeduplicate: true,
      requiresHumanConfirmation: true,
      now,
    }));
    this.operations.set(operationId, { ...this.operations.get(operationId)!, status: 'waiting', updatedAt: now });
    this.state.pendingApprovalRefs = [{ approvalId, operationId, status: 'waiting' }];
    this.state.updatedAt = now;
    await this.checkpoint('waiting');
  }

  async resolveApproval(approvalId: string, status: 'approved' | 'rejected' | 'cancelled', now = Date.now()): Promise<void> {
    const ref = this.state.pendingApprovalRefs.find((approval) => approval.approvalId === approvalId);
    if (!ref) throw new Error(`Unknown Agent Team approval: ${approvalId}`);
    ref.status = status;
    const operation = this.operations.get(ref.operationId);
    if (operation) this.operations.set(ref.operationId, { ...operation, status: status === 'approved' ? 'succeeded' : 'failed', updatedAt: now });
    this.state.updatedAt = now;
    await this.checkpoint(status === 'approved' ? 'running' : 'waiting');
  }

  async markNodeDispatched(task: AgentTask, now = Date.now()): Promise<void> {
    const node = this.requireNode(task.id);
    if (node.status === 'completed') return;
    node.status = 'dispatched';
    const operation = this.operations.get(node.operationId);
    if (operation) this.operations.set(node.operationId, { ...operation, status: 'dispatched', updatedAt: now });
    if (!this.state.runningChildRefs.includes(node.id)) this.state.runningChildRefs.push(node.id);
    this.state.updatedAt = now;
    await this.checkpoint('running');
  }

  async markNodeTerminal(task: AgentTask, result: AgentTaskResult, now = Date.now()): Promise<void> {
    const node = this.requireNode(task.id);
    node.status = result.cancelled ? 'cancelled' : result.blocked ? 'blocked' : result.success ? 'completed' : 'failed';
    node.result = { ...result, toolsUsed: [...result.toolsUsed] };
    node.error = result.error;
    node.resultRef = resultRef(this.scope.runId, task.id, result);
    this.state.completedNodeResultRefs[task.id] = node.resultRef;
    if (result.output) this.state.findings[task.id] = result.output;
    const decision = result.output.match(/(?:^|\n)DECISION:\s*(.+)/i)?.[1]?.trim();
    if (decision) this.state.decisions[task.id] = decision;
    const artifactPaths = result.output.match(/(?:^|\s)(?:file|path):\s*([^\s]+)/gi)?.map((entry) =>
      entry.replace(/^(?:\s)*(?:file|path):\s*/i, '').trim()) ?? [];
    node.artifactRefs = [...new Set([...node.artifactRefs, ...artifactPaths])];
    this.state.artifactRefs[task.id] = [...node.artifactRefs];
    this.state.runningChildRefs = this.state.runningChildRefs.filter((ref) => ref !== task.id);
    if (result.error) this.state.errors.push(`[${task.id}] ${result.error}`);
    const operation = this.operations.get(node.operationId);
    if (operation) this.operations.set(node.operationId, {
      ...operation,
      status: result.success ? 'succeeded' : 'failed',
      resultRef: node.resultRef,
      updatedAt: now,
    });
    this.state.updatedAt = now;
    await this.checkpoint('running');
  }

  async enqueueMessage(agentId: string, body: string, from = 'parent', type = 'text', now = Date.now()): Promise<AgentTeamMailboxMessage> {
    const seq = this.state.mailbox.nextSeq++;
    const message: AgentTeamMailboxMessage = {
      id: `${this.scope.treeId}:mail:${seq}`,
      seq,
      treeId: this.scope.treeId,
      agentId,
      from,
      type,
      body,
      createdAt: now,
    };
    this.state.mailbox.pending.push(message);
    this.state.updatedAt = now;
    await this.checkpoint('running');
    return message;
  }

  async consumeMessages(agentId: string, now = Date.now()): Promise<AgentTeamMailboxMessage[]> {
    const consumed = new Set(this.state.mailbox.consumedMessageIds);
    const messages = this.state.mailbox.pending
      .filter((message) => message.agentId === agentId && message.treeId === this.scope.treeId && !consumed.has(message.id))
      .sort((left, right) => left.seq - right.seq);
    for (const message of messages) consumed.add(message.id);
    this.state.mailbox.consumedMessageIds = [...consumed];
    this.state.mailbox.committedCursor = Math.max(this.state.mailbox.committedCursor, ...messages.map((message) => message.seq), 0);
    this.state.mailbox.pending = this.state.mailbox.pending.filter((message) => !consumed.has(message.id));
    this.state.updatedAt = now;
    await this.checkpoint('running');
    return messages;
  }

  async cancel(reason: string, now = Date.now()): Promise<void> {
    this.state.cancelled = true;
    this.state.errors.push(`Cancelled: ${reason}`);
    for (const node of this.state.taskGraph) {
      if (!['completed', 'failed', 'blocked', 'cancelled'].includes(node.status)) node.status = 'cancelled';
    }
    this.state.runningChildRefs = [];
    this.state.updatedAt = now;
    await this.checkpoint('recovering');
  }

  async terminal(status: 'completed' | 'failed' | 'cancelled', reason?: string, now = Date.now()): Promise<void> {
    await this.serial;
    await this.parentHost.projectAgentTeamChildTerminal({
      parentRunId: this.parentRunId,
      teamRunId: this.scope.runId,
      status,
      resultRef: status === 'completed' ? `agent-team:${this.scope.runId}:completed` : undefined,
      now,
    });
    await this.kernel.terminal({
      runId: this.scope.runId,
      attempt: this.attempt,
      owner: this.owner,
      now,
      status,
      reason,
      event: {
        type: `agent_team_${status}`,
        payload: { treeId: this.scope.treeId, reason },
        recordedAt: now,
      },
    });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.terminalized = true;
  }

  private requireNode(taskId: string): AgentTeamCheckpointNode {
    const node = this.state.taskGraph.find((candidate) => candidate.id === taskId);
    if (!node) throw new Error(`Unknown Agent Team node: ${taskId}`);
    return node;
  }

  private startHeartbeat(now: number): void {
    const intervalMs = Math.max(250, Math.floor((this.owner.leaseExpiresAt - now) / 3));
    this.heartbeatTimer = setInterval(() => {
      void this.kernel.heartbeat(this.scope.runId, this.owner, Date.now()).then((owner) => {
        this.owner = owner;
      }).catch(() => {
        this.terminalized = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      });
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }
}

export class AgentTeamDurableRuntime implements AgentTeamDurableRuntimePort {
  constructor(
    private readonly kernel: RunKernelAdapter,
    private readonly parentHost: AgentTeamDurableParentHost,
  ) {}

  async start(input: AgentTeamDurableStartInput): Promise<AgentTeamDurableController> {
    const now = input.now ?? Date.now();
    if (input.scope.runId !== stableAgentTeamRunId(input.parentRunId, input.logicalOperationId)) {
      throw new Error('Agent Team run identity must be stable for its parent logical operation');
    }
    await this.parentHost.prepareAgentTeamChild({
      parentRunId: input.parentRunId,
      teamRunId: input.scope.runId,
      treeId: input.scope.treeId,
      logicalOperationId: input.logicalOperationId,
      sideEffect: input.sideEffect,
      now,
    });
    const state: AgentTeamCheckpointState = {
      schemaVersion: AGENT_TEAM_CHECKPOINT_SCHEMA_VERSION,
      kind: 'agent_team',
      teamId: input.scope.runId,
      treeId: input.scope.treeId,
      scope: { ...input.scope },
      parentRunId: input.parentRunId,
      taskGraph: input.tasks.map((task) => {
        const profile = agentTeamTaskPermissionProfile(task);
        return {
          id: task.id,
          role: task.role,
          task: task.task,
          dependsOn: [...(task.dependsOn ?? [])],
          model: input.model,
          tools: [...task.tools],
          permissionProfile: profile,
          sideEffect: profile !== 'readonly',
          status: 'prepared',
          operationId: `node:${task.id}`,
          artifactRefs: [],
        };
      }),
      mailbox: { nextSeq: 1, committedCursor: 0, pending: [], consumedMessageIds: [] },
      findings: {},
      decisions: {},
      errors: [],
      completedNodeResultRefs: {},
      runningChildRefs: [],
      pendingApprovalRefs: [],
      worktreeRefs: {},
      artifactRefs: {},
      cancelled: false,
      updatedAt: now,
    };
    const initialOperations = state.taskGraph.map((node) => this.kernel.prepareOperation({
      runId: input.scope.runId,
      operationId: node.operationId,
      logicalOperationId: node.id,
      attempt: 1,
      kind: 'child_run',
      sideEffect: node.sideEffect,
      canDeduplicate: false,
      now,
    }));
    const created = await this.kernel.createRun({
      runId: input.scope.runId,
      sessionId: input.scope.sessionId,
      engine: { kind: 'agent_team', treeId: input.scope.treeId },
      parentRunId: input.parentRunId,
      now,
      initialEngineCursor: { schemaVersion: AGENT_TEAM_CHECKPOINT_SCHEMA_VERSION, treeId: input.scope.treeId, mailboxCursor: 0 },
      initialPendingOperations: initialOperations,
    });
    const activeTrace = getActiveRunTraceContext();
    const traceContext = activeTrace ? createChildRunTraceContext(activeTrace, {
      runId: input.scope.runId,
      sessionId: input.scope.sessionId,
      attempt: created.attempt.attempt,
      ownerEpoch: created.owner.epoch,
      engine: 'agent_team',
      parentRunId: input.parentRunId,
      processInstanceId: created.owner.processInstanceId,
    }) : undefined;
    const controller = new Controller(
      input.scope,
      input.parentRunId,
      created.owner,
      created.attempt.attempt,
      this.kernel,
      this.parentHost,
      state,
      traceContext,
    );
    await controller.checkpoint('running');
    return controller;
  }
}

let configuredRuntime: AgentTeamDurableRuntimePort | null = null;

export function configureAgentTeamDurableRuntime(runtime: AgentTeamDurableRuntimePort | null): void {
  configuredRuntime = runtime;
}

export function getAgentTeamDurableRuntime(): AgentTeamDurableRuntimePort {
  if (!configuredRuntime) {
    throw new Error('Agent Team Durable Run persistence is unavailable; refusing to spawn agents');
  }
  return configuredRuntime;
}
