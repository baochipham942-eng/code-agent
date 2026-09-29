// ============================================================================
// N-MEMBER-INPUT-DROP ①(a) — 原生子代理最后一轮 LLM 期间的 send_input 必须被读到
// ----------------------------------------------------------------------------
// 收尾只查 taskGate、不看收件箱时：最后一次模型调用期间入队的补话停在队列里，
// 成员不再迭代，结果里也没有「未送达 N 条」。修完后：非空则续跑（上限 2），
// 超过上限的残留写进结果，并跟着父代理完成通知走。
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../../../src/host/agent/spawnGuard';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';
import type { CanUseToolFn, ToolContext } from '../../../src/host/protocol/tools';
import type { SwarmRunScope } from '../../../src/shared/contract/swarm';

const mocks = vi.hoisted(() => {
  const responses: Array<Record<string, unknown>> = [];
  const seen: string[] = [];
  const inference = vi.fn(async (messages: unknown) => {
    seen.push(JSON.stringify(messages));
    const response = responses.shift();
    if (!response) throw new Error('Missing mocked inference response');
    return response;
  });
  const pipelineContext = {
    agentId: 'pipeline-agent',
    permissionConfig: { blockedCommands: [] as string[] },
  };
  const pipeline = {
    createContext: vi.fn(() => pipelineContext),
    checkBudget: vi.fn(() => ({ allowed: true, warnings: [] as string[] })),
    checkToolExecution: vi.fn(() => ({ allowed: true })),
    completeContext: vi.fn(),
    getBudgetStatus: vi.fn(() => ({ subagentCost: 0 })),
    getRemainingBudget: vi.fn(() => undefined),
    recordTokenUsage: vi.fn(),
    recordToolUsage: vi.fn(),
  };
  return { responses, seen, inference, pipeline, pipelineContext };
});

vi.mock('../../../src/host/services/infra/logger', () => ({
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dispose: vi.fn() },
}));

vi.mock('../../../src/host/model/modelRouter', () => ({
  ModelRouter: class { inference = mocks.inference; },
  PROVIDER_REGISTRY: { test: { models: [{ id: 'test-model', supportsTool: true }] } },
}));

vi.mock('../../../src/host/model/adapters/aiSdkAdapter', () => ({
  aiSdkSupportsProvider: () => false,
  inferenceViaAiSdk: vi.fn(),
}));

vi.mock('../../../src/host/agent/subagentPipeline', () => ({
  getSubagentPipeline: () => mocks.pipeline,
}));

vi.mock('../../../src/host/agent/subagentToolRuntime', () => ({
  createSubagentToolRuntime: () => ({ executor: { execute: vi.fn() }, policy: {} }),
}));

vi.mock('../../../src/host/agent/agentTask', () => ({
  AgentTask: class {
    id: string;
    appendTranscript = vi.fn();
    stop = vi.fn();
    fail = vi.fn();
    constructor(id: string) { this.id = id; }
  },
}));

vi.mock('../../../src/host/agent/subagentLifecycleHooks', () => ({
  startSubagentLifecycle: ({ context }: { context: { sessionId: string } }) => context.sessionId,
}));

vi.mock('../../../src/host/agent/subagentExecutionTracing', () => ({
  runSubagentExecutionWithTrace: (_request: unknown, run: () => Promise<unknown>) => run(),
}));

vi.mock('../../../src/host/agent/subagentExecutionRouter', () => ({
  routeExternalSubagentExecution: () => null,
}));

vi.mock('../../../src/host/agent/subagentFirstRunPreset', () => ({
  resolveSubagentPreset: async (preset: unknown) => preset,
}));

vi.mock('../../../src/host/agent/subagentProtocolContext', () => ({
  normalizeSubagentModelContext: (context: unknown) => context,
  resolveSubagentParentContext: () => ({ availableTools: [] }),
}));

vi.mock('../../../src/host/agent/childContext', () => ({
  buildChildContext: (child: { allowedTools: string[] }) => ({
    toolPool: child.allowedTools,
    permissions: { deny: [], blockedCommands: [], effectiveMode: 'default' },
  }),
}));

vi.mock('../../../src/host/agent/subagentExecutorCancellation', () => ({
  getChildSubagentExecutionTimeout: () => 60_000,
  getSubagentIdleTimeout: () => 30_000,
  flushSubagentCancellation: vi.fn(async () => {}),
  createSubagentCancellationLifecycle: () => {
    const controller = new AbortController();
    return {
      effectiveController: controller,
      effectiveSignal: controller.signal,
      cleanupTimer: vi.fn(),
      markProgress: vi.fn(),
      markRequestStart: vi.fn(),
      markRequestEnd: vi.fn(),
      markToolStart: vi.fn(),
      markToolEnd: vi.fn(),
      stopIdleWatchdog: vi.fn(),
    };
  },
}));

vi.mock('../../../src/host/platform/appPaths', () => ({
  getUserDataPath: () => '/tmp',
  getPath: () => '/tmp',
}));

vi.mock('../../../src/host/services/checkpoint/taskPatchService', () => ({
  captureWorkspacePatch: vi.fn(async () => undefined),
}));

vi.mock('../../../src/host/context/subagentContextStore', () => ({
  getSubagentContextStore: () => ({ upsert: vi.fn() }),
}));

vi.mock('../../../src/host/context/contextInterventionState', () => ({
  getContextInterventionState: () => ({ getEffectiveSnapshot: () => ({}) }),
}));

vi.mock('../../../src/host/context/contextInterventionHelpers', () => ({
  applyInterventionsToMessages: (messages: unknown) => messages,
}));

vi.mock('../../../src/host/agent/subagentCompaction', () => ({
  compactSubagentMessages: () => false,
}));

vi.mock('../../../src/host/telemetry/telemetryCollector', () => ({
  getTelemetryCollector: () => ({ recordDetachedTurn: vi.fn() }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({ permissions: { inheritance: 'strict-inherit' } }),
  }),
}));

vi.mock('../../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => [],
  adoptOrphanTasks: vi.fn(),
}));

vi.mock('../../../src/host/services/roleAssets', () => ({
  buildRoleContextBlock: vi.fn(),
  runRoleWriteBack: vi.fn(async () => {}),
  recordRoleParticipation: vi.fn(),
  applyRoleBoundaryToSubagentRequest: vi.fn((request: unknown) => request),
}));

import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { executeSendInput } from '../../../src/host/tools/modules/multiagent/sendInput';
import {
  initParallelAgentCoordinator,
  resetParallelAgentCoordinators,
} from '../../../src/host/agent/parallelAgentCoordinator';
import type { ParallelAgentCoordinator } from '../../../src/host/agent/parallelAgentCoordinator';

const allowAll: CanUseToolFn = async () => ({ allow: true });

function textResponse(content: string) {
  return { type: 'text', content, usage: { inputTokens: 1, outputTokens: 1 } };
}

function makeCtx(): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess-wind-down',
    workingDir: '/tmp/member-input-drop',
    abortSignal: ctrl.signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: () => undefined,
  } as unknown as ToolContext;
}

function coordinatorQueue(coordinator: ParallelAgentCoordinator, agentId: string): AgentMessage[] {
  return (coordinator as unknown as { messageQueues: Map<string, AgentMessage[]> }).messageQueues.get(agentId) ?? [];
}

describe('native member follow-up during the final model call (N-MEMBER-INPUT-DROP)', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    mocks.seen.length = 0;
    mocks.inference.mockClear();
    resetSpawnGuard();
    resetParallelAgentCoordinators();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });

  afterEach(() => {
    resetSpawnGuard();
    resetParallelAgentCoordinators();
    delete process.env.CODE_AGENT_MODEL_ENGINE;
  });

  it('reads a send_input that arrives during the last LLM call', async () => {
    const agentId = 'native-member-a';
    const followUp = 'add the page numbers';
    mocks.responses.push(textResponse('draft answer'), textResponse('answer with page numbers'));
    const guard = getSpawnGuard();
    const executor = new SubagentExecutor();
    const request = {
      prompt: 'Summarize the report',
      config: {
        name: 'Native member',
        systemPrompt: 'Be brief.',
        availableTools: [] as string[],
        maxIterations: 4,
      },
      context: {
        sessionId: 'sess-wind-down',
        cwd: '/tmp/member-input-drop',
        modelConfig: { provider: 'test', model: 'test-model' },
        resolver: { getDefinition: () => undefined },
        permission: { request: vi.fn(async () => true) },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
        spawnGuardId: agentId,
        executionAgentId: agentId,
      },
    };

    let queuedDuringCall = false;
    mocks.inference.mockImplementationOnce(async (messages: unknown) => {
      mocks.seen.push(JSON.stringify(messages));
      const sent = await executeSendInput(
        { agentId, message: followUp },
        makeCtx(),
        allowAll,
      );
      queuedDuringCall = sent.ok === true;
      const response = mocks.responses.shift();
      if (!response) throw new Error('Missing mocked inference response');
      return response;
    });

    const run = executor.execute(request);
    guard.register(agentId, 'coder', 'Summarize the report', run, new AbortController());
    const result = await run;

    expect(queuedDuringCall).toBe(true);
    expect(mocks.inference).toHaveBeenCalledTimes(2);
    expect(mocks.seen[1]).toContain(followUp);
    expect(guard.peekMessages(agentId)).toEqual([]);
    expect(result.output).not.toContain('未送达');
    expect(result.success).toBe(true);
  });

  it('reads a coordinator-queue message that arrives during the last LLM call', async () => {
    const agentId = 'coordinator-member-a';
    const followUp = 'switch the chart to quarters';
    const scope: SwarmRunScope = {
      sessionId: 'sess-wind-down',
      runId: 'run-wind-down',
      treeId: 'tree-wind-down',
    };
    const coordinator = initParallelAgentCoordinator({}, scope);
    const definitions = (coordinator as unknown as { taskDefinitions: Map<string, { id: string; role: string; task: string; tools: string[] }> }).taskDefinitions;
    definitions.set(agentId, { id: agentId, role: 'researcher', task: 'chart', tools: [] });
    (coordinator as unknown as { messageQueues: Map<string, AgentMessage[]> }).messageQueues.set(agentId, []);

    mocks.responses.push(textResponse('chart draft'), textResponse('quarterly chart'));
    mocks.inference.mockImplementationOnce(async (messages: unknown) => {
      mocks.seen.push(JSON.stringify(messages));
      const sent = await coordinator.sendMessage(agentId, followUp, {
        senderKind: 'orchestrator',
        sessionId: scope.sessionId,
        runId: scope.runId,
      });
      expect(sent).toBe(true);
      const response = mocks.responses.shift();
      if (!response) throw new Error('Missing mocked inference response');
      return response;
    });

    const result = await new SubagentExecutor().execute({
      prompt: 'Draw the chart',
      config: {
        name: 'Coordinator member',
        systemPrompt: 'Be brief.',
        availableTools: [],
        maxIterations: 4,
      },
      context: {
        sessionId: scope.sessionId,
        runId: scope.runId,
        cwd: '/tmp/member-input-drop',
        modelConfig: { provider: 'test', model: 'test-model' },
        resolver: { getDefinition: () => undefined },
        permission: { request: vi.fn(async () => true) },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
        swarmRunScope: scope,
        executionAgentId: agentId,
        messageDrain: async () => {
          const queue = coordinatorQueue(coordinator, agentId);
          const copy = [...queue];
          queue.length = 0;
          return copy;
        },
      },
    });

    expect(mocks.inference).toHaveBeenCalledTimes(2);
    expect(mocks.seen[1]).toContain(followUp);
    expect(coordinatorQueue(coordinator, agentId)).toEqual([]);
    expect(result.output).not.toContain('未送达');
  });

  it('reports follow-ups still queued after the wind-down reentry cap in the result and the parent notification', async () => {
    const agentId = 'native-member-cap';
    const guard = getSpawnGuard();
    for (let i = 0; i < 4; i += 1) mocks.responses.push(textResponse(`answer ${i}`));
    mocks.inference.mockImplementation(async (messages: unknown) => {
      const call = mocks.seen.length + 1;
      mocks.seen.push(JSON.stringify(messages));
      const sent = await executeSendInput(
        { agentId, message: `follow-up-${call}` },
        makeCtx(),
        allowAll,
      );
      expect(sent.ok).toBe(true);
      const response = mocks.responses.shift();
      if (!response) throw new Error('Missing mocked inference response');
      return response;
    });

    const executor = new SubagentExecutor();
    const run = executor.execute({
      prompt: 'Keep going',
      config: {
        name: 'Native member',
        systemPrompt: 'Be brief.',
        availableTools: [],
        maxIterations: 6,
      },
      context: {
        sessionId: 'sess-wind-down',
        cwd: '/tmp/member-input-drop',
        modelConfig: { provider: 'test', model: 'test-model' },
        resolver: { getDefinition: () => undefined },
        permission: { request: vi.fn(async () => true) },
        events: { emit: vi.fn() },
        abortSignal: new AbortController().signal,
        spawnGuardId: agentId,
        executionAgentId: agentId,
      },
    });
    guard.register(agentId, 'coder', 'Keep going', run, new AbortController());
    const result = await run;
    const notifications = guard.drainNotifications();

    expect(result.success).toBe(true);
    expect(result.output).toContain('未送达 1 条');
    expect(notifications.join('\n')).toContain('未送达 1 条');
    expect(mocks.seen.some((body) => body.includes('follow-up-1'))).toBe(true);
    expect(mocks.seen.some((body) => body.includes('follow-up-2'))).toBe(true);
    expect(mocks.seen.some((body) => body.includes('follow-up-3'))).toBe(false);
  });

  it('wind-down reads the two live queues and does not aggregate the teammate inbox', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const windDown = readFileSync(join(root, 'src/host/agent/memberInputWindDown.ts'), 'utf8');
    const executor = readFileSync(join(root, 'src/host/agent/subagentExecutor.ts'), 'utf8');
    expect(windDown).not.toContain('peekAgentInbox');
    expect(executor).not.toContain('peekAgentInbox');
    expect(windDown).not.toContain('getParallelAgentCoordinator(');
    expect(windDown).toContain('peekMessages');
  });
});
