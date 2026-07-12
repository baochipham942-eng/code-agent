import path from 'node:path';
import type { AgentEngineRunResult } from '../../shared/contract/agentEngine';
import type { PendingOperation } from '../../shared/contract/durableRun';
import {
  buildAgentTeamRecoveryDecision,
  canRecoverAgentTeam,
  rehydrateAgentTeam,
} from '../agent/agentTeamRecovery';
import {
  getParallelAgentCoordinatorRegistry,
  type ParallelAgentCoordinator,
} from '../agent/parallelAgentCoordinator';
import { getSubagentExecutor } from '../agent/subagentExecutor';
import {
  McpDurableTaskController,
  createMcpKernelCheckpointPort,
  createMcpTaskRecoveryHandler,
  type McpTaskCapability,
  type McpTaskProtocol,
  type McpTaskResultStore,
} from '../mcp/mcpDurableTask';
import type { MCPClient } from '../mcp/mcpClient';
import { ClaudeCodeAdapter } from '../services/agentEngine/claudeCodeAdapter';
import { CodexCliAdapter } from '../services/agentEngine/codexCliAdapter';
import {
  ExternalEngineDurableLifecycle,
  buildExternalEngineRecoveryDecision,
  canRecoverExternalEngine,
  readExternalEngineRecoveryLaunchContext,
  resumeExternalEngine,
  type ExternalEngineRecoveryDecision,
} from '../services/agentEngine/externalEngineDurableLifecycle';
import {
  createClaudeResumeLaunch,
  createCodexResumeLaunch,
} from '../services/agentEngine/externalEngineResumeBuilders';
import { getLogsPath } from '../platform/appPaths';
import type { RunKernelAdapter } from './durableRunKernel';
import type { RunRehydrationPlan } from './durableRunStores';
import type { RunRegistry } from './runRegistry';
import type {
  DurableEngineRecoveryHandler,
  DurableOperationRecoveryHandler,
} from './durableRecoveryDispatcher';

export interface ExternalResumeRunners {
  codex(input: Parameters<CodexCliAdapter['run']>[0]): Promise<AgentEngineRunResult>;
  claude(input: Parameters<ClaudeCodeAdapter['run']>[0]): Promise<AgentEngineRunResult>;
}

export function createNativeRecoveryHandler(): DurableEngineRecoveryHandler {
  return reviewOnlyEngineHandler('native', 'native runtime continuation is not registered');
}

export function createDynamicWorkflowRecoveryHandler(): DurableEngineRecoveryHandler {
  return reviewOnlyEngineHandler('dynamic_workflow', 'dynamic workflow continuation is not registered');
}

export function createAgentTeamRecoveryHandler(): DurableEngineRecoveryHandler {
  const recoveredCoordinators = new Set<ParallelAgentCoordinator>();
  return {
    name: 'agent_team',
    engineKind: 'agent_team',
    async recover(plan) {
      const decision = buildAgentTeamRecoveryDecision(plan);
      if (!canRecoverAgentTeam(plan)) {
        return { status: 'requires_review', reason: 'agent team checkpoint is missing or unsupported', detail: decision };
      }
      const result = await rehydrateAgentTeam(plan, {
        createCoordinator: (state) => {
          const coordinator = getParallelAgentCoordinatorRegistry().getOrCreate(state.scope);
          coordinator.setSubagentExecutor(getSubagentExecutor());
          recoveredCoordinators.add(coordinator);
          return coordinator;
        },
      });
      if (result.decision.classification === 'requires_review' || result.decision.classification === 'failed') {
        return { status: 'requires_review', reason: result.decision.classification, detail: result.decision };
      }
      return {
        status: result.decision.classification === 'waiting_for_approval' ? 'observing' : 'recovered',
        reason: result.decision.classification,
        detail: result.decision,
      };
    },
    shutdown() {
      for (const coordinator of recoveredCoordinators) coordinator.abortAllRunning('coordinator_shutdown');
      recoveredCoordinators.clear();
    },
  };
}

export function createExternalEngineRecoveryHandler(input: {
  registry: RunRegistry;
  runners?: ExternalResumeRunners;
}): DurableEngineRecoveryHandler {
  const activeLifecycles = new Set<ExternalEngineDurableLifecycle>();
  const runners = input.runners ?? {
    codex: (request) => new CodexCliAdapter().run(request),
    claude: (request) => new ClaudeCodeAdapter().run(request),
  };
  return {
    name: 'external_cli',
    engineKind: 'external_cli',
    getDispatchKey(plan) {
      const decision = buildExternalEngineRecoveryDecision(plan);
      return ['external', plan.envelope.runId, plan.envelope.attempt, decision.externalSessionId ?? 'missing'].join(':');
    },
    async recover(plan) {
      if (!canRecoverExternalEngine(plan)) {
        return { status: 'unsupported', reason: 'plan is not an external CLI run' };
      }
      const decision = buildExternalEngineRecoveryDecision(plan);
      if (decision.action === 'already_terminal') return { status: 'already_terminal', reason: decision.reason, detail: decision };
      if (decision.action !== 'resume' || !decision.externalSessionId) {
        return { status: 'requires_review', reason: decision.reason, detail: decision };
      }
      const context = readExternalEngineRecoveryLaunchContext(plan);
      if (!context || !plan.envelope.owner) {
        return { status: 'requires_review', reason: 'safe external recovery launch context is unavailable', detail: decision };
      }
      const lifecycle = ExternalEngineDurableLifecycle.rehydrate({
        registry: input.registry,
        plan,
        context,
        externalSessionId: decision.externalSessionId,
      });
      activeLifecycles.add(lifecycle);
      try {
        const result = await resumeExternalEngine(plan, {
          resume: (nextDecision) => runExternalResume(nextDecision, plan, context, lifecycle, runners),
        });
        if ('action' in result) {
          return { status: 'requires_review', reason: result.reason, detail: result };
        }
        return {
          status: result.status === 'completed' ? 'recovered' : result.status === 'cancelled' ? 'requires_review' : 'failed',
          reason: `external resume ${result.status}`,
          detail: result,
        };
      } catch (error) {
        const failed: AgentEngineRunResult = {
          runId: plan.envelope.runId,
          sessionId: plan.envelope.sessionId,
          engine: plan.envelope.engine.kind === 'external_cli' ? plan.envelope.engine.engine : 'codex_cli',
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
        await lifecycle.finish(failed, true).catch(() => undefined);
        return { status: 'failed', reason: failed.error ?? 'external resume failed', detail: failed };
      } finally {
        activeLifecycles.delete(lifecycle);
      }
    },
    async shutdown() {
      await Promise.allSettled([...activeLifecycles].map((lifecycle) => lifecycle.terminateProcess('SIGTERM')));
    },
  };
}

async function runExternalResume(
  decision: ExternalEngineRecoveryDecision,
  plan: RunRehydrationPlan,
  context: NonNullable<ReturnType<typeof readExternalEngineRecoveryLaunchContext>>,
  lifecycle: ExternalEngineDurableLifecycle,
  runners: ExternalResumeRunners,
): Promise<AgentEngineRunResult> {
  if (!decision.externalSessionId || !plan.envelope.owner) throw new Error('External resume identity is incomplete');
  const common = {
    runId: plan.envelope.runId,
    sessionId: plan.envelope.sessionId,
    attempt: plan.envelope.attempt,
    ownerEpoch: plan.envelope.owner.epoch,
    externalSessionId: decision.externalSessionId,
    cwd: context.cwd,
    model: context.model,
    permissionProfile: context.permissionProfile,
  };
  if (decision.engine === 'codex_cli') {
    const resumeLaunch = createCodexResumeLaunch({
      ...common,
      lastMessagePath: path.join(getLogsPath(), 'agent-engines', 'codex-cli', `${plan.envelope.runId}.last.md`),
    });
    return runners.codex({
      sessionId: plan.envelope.sessionId,
      prompt: '',
      cwd: context.cwd,
      workspaceRoot: context.workspace,
      model: context.model,
      permissionProfile: context.permissionProfile,
      durableLifecycle: lifecycle,
      resumeLaunch,
    });
  }
  if (decision.engine === 'claude_code') {
    const resumeLaunch = createClaudeResumeLaunch(common);
    return runners.claude({
      sessionId: plan.envelope.sessionId,
      prompt: '',
      cwd: context.cwd,
      workspaceRoot: context.workspace,
      model: context.model,
      permissionProfile: context.permissionProfile,
      durableLifecycle: lifecycle,
      resumeLaunch,
    });
  }
  throw new Error(`${decision.engine} has no safe resume builder`);
}

export function createMcpOperationRecoveryHandler(input: {
  kernel: RunKernelAdapter;
  resultStore: McpTaskResultStore;
  getClient: () => MCPClient;
  trustedServerIdentities: ReadonlySet<string>;
}): DurableOperationRecoveryHandler {
  const protocol: McpTaskProtocol = {
    createTask: async () => { throw new Error('Recovery never creates a new MCP task'); },
    getTask: (request) => requireMcpProtocol(input, request.serverIdentity).getTask(request),
    cancelTask: (request) => requireMcpProtocol(input, request.serverIdentity).cancelTask(request),
    resolveTaskResult: (request) => requireMcpProtocol(input, request.serverIdentity).resolveTaskResult(request),
  };
  return {
    name: 'mcp_tool_call',
    matches: (_plan, operation) => isExplicitMcpOperation(operation),
    async recover(plan, operation, now) {
      if (!plan.envelope.owner) return { status: 'requires_review', reason: 'MCP recovery has no claimed owner' };
      const checkpoint = createMcpKernelCheckpointPort({
        kernel: input.kernel,
        runId: plan.envelope.runId,
        attempt: plan.envelope.attempt,
        owner: plan.envelope.owner,
        initialPendingOperations: plan.pendingOperations,
        childRuns: plan.childRuns,
        getState: () => plan.checkpoint?.state,
        getEngineCursor: () => plan.checkpoint?.cursor.engineCursor ?? plan.envelope.cursor.engineCursor,
      });
      const controller = new McpDurableTaskController({ kernel: input.kernel, checkpoint, protocol, resultStore: input.resultStore });
      const recover = createMcpTaskRecoveryHandler(controller, {
        resolveCapability: (serverIdentity) => resolveMcpRecoveryCapability(input, serverIdentity),
        isMcpOperation: (candidate) => candidate.operationId === operation.operationId && isExplicitMcpOperation(candidate),
      });
      const [decision] = await recover(plan, now);
      if (!decision) return { status: 'requires_review', reason: 'MCP operation was not recoverable' };
      return {
        status: decision.action === 'reuse_result' ? 'recovered'
          : decision.action === 'observe' || decision.action === 'query' ? 'observing'
            : decision.action === 'requires_review' ? 'requires_review' : 'recovered',
        reason: decision.reason,
        detail: decision,
      };
    },
  };
}

function isExplicitMcpOperation(operation: PendingOperation): boolean {
  return operation.kind === 'tool_call' && operation.providerOperationId?.startsWith('mcp-task:v1:') === true;
}

function resolveMcpRecoveryCapability(
  input: { getClient: () => MCPClient; trustedServerIdentities: ReadonlySet<string> },
  serverIdentity: string,
): McpTaskCapability | undefined {
  const client = input.getClient();
  for (const state of client.getServerStates()) {
    const serverName = state.config.name;
    if (client.getServerIdentity(serverName) !== serverIdentity) continue;
    for (const tool of client.getTools().filter((candidate) => candidate.serverName === serverName)) {
      const capability = client.buildTaskCapability(serverName, tool.name, input.trustedServerIdentities);
      if (capability?.query) return capability;
    }
  }
  return undefined;
}

function requireMcpProtocol(
  input: { getClient: () => MCPClient; trustedServerIdentities: ReadonlySet<string> },
  serverIdentity: string,
): McpTaskProtocol {
  const capability = resolveMcpRecoveryCapability(input, serverIdentity);
  if (!capability?.trusted || !capability.query) throw new Error('MCP recovery server is not trusted and queryable');
  const client = input.getClient();
  for (const state of client.getServerStates()) {
    if (client.getServerIdentity(state.config.name) !== serverIdentity) continue;
    const protocol = client.createTaskProtocol(state.config.name, serverIdentity);
    if (protocol) return protocol;
  }
  throw new Error('MCP recovery protocol is unavailable');
}

function reviewOnlyEngineHandler(
  engineKind: 'native' | 'dynamic_workflow',
  reason: string,
): DurableEngineRecoveryHandler {
  return {
    name: engineKind,
    engineKind,
    async recover() {
      return { status: 'requires_review', reason };
    },
  };
}
