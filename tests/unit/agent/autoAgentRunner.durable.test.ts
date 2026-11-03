import { beforeEach, describe, expect, it, vi } from 'vitest';

const coordinatorState = vi.hoisted(() => ({ execute: vi.fn() }));
const factoryState = vi.hoisted(() => ({ create: vi.fn() }));
const durableState = vi.hoisted(() => ({
  start: vi.fn(),
  persist: vi.fn(),
  terminal: vi.fn(),
}));
const loggerState = vi.hoisted(() => ({ warn: vi.fn() }));
const sessionManagerState = vi.hoisted(() => ({ addMessageToSession: vi.fn() }));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: loggerState.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/agent/autoAgentCoordinator', () => ({
  getAutoAgentCoordinator: () => ({ execute: coordinatorState.execute }),
}));
vi.mock('../../../src/host/agent/dynamicAgentFactory', () => ({
  getDynamicAgentFactory: () => ({ create: factoryState.create }),
}));
vi.mock('../../../src/host/agent/agentRequirementsAnalyzer', () => ({
  getAgentRequirementsAnalyzer: () => ({ analyze: vi.fn() }),
}));
vi.mock('../../../src/host/agent/autoAgentDurableRuntime', () => ({
  getAutoAgentDurableRuntime: () => ({ start: durableState.start }),
}));
vi.mock('../../../src/host/telemetry/runTraceContext', () => ({
  getActiveRunTraceContext: () => ({ runId: 'run-parent' }),
}));
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
}));
vi.mock('../../../src/host/scheduler/TaskDAG', () => ({
  TaskDAG: class { addAgentTask = vi.fn(); },
}));
vi.mock('../../../src/host/scheduler/dagEventBridge', () => ({ sendDAGInitEvent: vi.fn() }));
vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({ name: 'mock-tool-resolver' }),
}));

import { runAutoAgentMode } from '../../../src/host/agent/orchestrator/autoAgentRunner';

function makeTaskListManager() {
  return {
    reset: vi.fn(),
    createTask: vi.fn((input) => ({
      id: `task-${input.subject}`,
      subject: input.subject,
      description: input.description,
    })),
    getState: vi.fn(() => ({ requireApproval: false })),
    waitForApproval: vi.fn(),
    startExecution: vi.fn(),
    completeExecution: vi.fn(),
    failExecution: vi.fn(),
  };
}

function makeDeps() {
  return {
    workingDirectory: '/tmp/project',
    sessionId: 'session-auto-1',
    sourceMessageId: 'message-auto-1',
    taskListManager: makeTaskListManager() as never,
    generateId: () => 'message-1',
    addMessage: vi.fn(),
    sendDAGStatusEvent: vi.fn(),
    runStandardAgentLoop: vi.fn(),
  };
}

function run(deps: ReturnType<typeof makeDeps>) {
  return runAutoAgentMode(
    'do the work',
    'do the work with context',
    { taskType: 'work', executionStrategy: 'sequential', confidence: 0.9 } as never,
    vi.fn(),
    { provider: 'mock', model: 'mock-model' } as never,
    deps,
    'session-auto-1',
  );
}

describe('runAutoAgentMode durable terminal containment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factoryState.create.mockReturnValue([{
      id: 'agent-worker',
      name: 'Worker',
      role: 'worker',
      systemPrompt: 'do the work',
      taskDescription: 'work',
      tools: ['read_file'],
      maxIterations: 1,
      maxBudget: 1,
      priority: 1,
      canRunParallel: false,
    }]);
    durableState.start.mockResolvedValue({
      runId: 'auto-child',
      persist: durableState.persist,
      terminal: durableState.terminal,
    });
    durableState.persist.mockResolvedValue(undefined);
    durableState.terminal.mockResolvedValue(undefined);
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
    coordinatorState.execute.mockResolvedValue({
      success: true,
      strategy: 'sequential',
      results: [],
      aggregatedOutput: 'completed output',
      totalDuration: 1,
      totalIterations: 1,
      totalCost: 0,
      errors: [],
    });
  });

  it('preserves a successful graph result when durable terminal is fenced', async () => {
    durableState.terminal.mockRejectedValue(new Error('Durable run write fenced by stale owner: auto-child'));
    const deps = makeDeps();

    await expect(run(deps)).resolves.toBeUndefined();

    expect(deps.addMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'completed output' }));
    expect(loggerState.warn).toHaveBeenCalledWith(
      'Auto Agent durable terminal projection failed; preserving successful graph result',
      { runId: 'auto-child', reason: 'fenced', error: 'Durable run write fenced by stale owner: auto-child' },
    );
  });

  it('distinguishes other durable terminal failures without failing a successful graph', async () => {
    durableState.terminal.mockRejectedValue(new Error('disk full'));

    await expect(run(makeDeps())).resolves.toBeUndefined();

    expect(loggerState.warn).toHaveBeenCalledWith(
      'Auto Agent durable terminal projection failed; preserving successful graph result',
      { runId: 'auto-child', reason: 'other', error: 'disk full' },
    );
  });

  it('still propagates a real graph failure', async () => {
    const failure = new Error('graph execution failed');
    coordinatorState.execute.mockRejectedValue(failure);

    await expect(run(makeDeps())).rejects.toBe(failure);

    expect(durableState.terminal).toHaveBeenCalledWith('failed', 'graph execution failed');
    expect(loggerState.warn).not.toHaveBeenCalledWith(
      'Auto Agent durable terminal projection failed; preserving successful graph result',
      expect.anything(),
    );
  });
});
