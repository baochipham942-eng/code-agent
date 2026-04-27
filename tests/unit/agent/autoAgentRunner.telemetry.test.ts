import { beforeEach, describe, expect, it, vi } from 'vitest';

const coordinatorState = vi.hoisted(() => ({
  execute: vi.fn(),
  capturedContext: undefined as unknown,
}));

const factoryState = vi.hoisted(() => ({
  create: vi.fn(),
}));

const sessionManagerState = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/main/agent/autoAgentCoordinator', () => ({
  getAutoAgentCoordinator: () => ({
    execute: coordinatorState.execute,
  }),
}));

vi.mock('../../../src/main/agent/dynamicAgentFactory', () => ({
  getDynamicAgentFactory: () => ({
    create: factoryState.create,
  }),
}));

vi.mock('../../../src/main/agent/agentRequirementsAnalyzer', () => ({
  getAgentRequirementsAnalyzer: () => ({
    analyze: vi.fn(),
  }),
}));

vi.mock('../../../src/main/services', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/main/scheduler/TaskDAG', () => ({
  TaskDAG: class {
    addAgentTask = vi.fn();
  },
}));

vi.mock('../../../src/main/scheduler/dagEventBridge', () => ({
  sendDAGInitEvent: vi.fn(),
}));

vi.mock('../../../src/main/protocol/dispatch/toolResolver', () => ({
  getToolResolver: () => ({ name: 'mock-tool-resolver' }),
}));

import { runAutoAgentMode } from '../../../src/main/agent/orchestrator/autoAgentRunner';

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

describe('runAutoAgentMode observability wiring', () => {
  beforeEach(() => {
    coordinatorState.execute.mockReset();
    coordinatorState.capturedContext = undefined;
    factoryState.create.mockReset();
    sessionManagerState.addMessageToSession.mockReset();

    factoryState.create.mockReturnValue([
      {
        id: 'agent-reviewer',
        name: 'Reviewer',
        role: 'reviewer',
        systemPrompt: 'review the work',
        taskDescription: 'review task',
        tools: ['read_file'],
        maxIterations: 1,
        maxBudget: 1,
        priority: 1,
        canRunParallel: false,
      },
    ]);
    coordinatorState.execute.mockImplementation(async (_agents, _requirements, context) => {
      coordinatorState.capturedContext = context;
      return {
        success: false,
        strategy: 'sequential',
        results: [],
        aggregatedOutput: '',
        totalDuration: 1,
        totalIterations: 0,
        totalCost: 0,
        errors: [],
      };
    });
  });

  it('passes the active sessionId into subagent toolContext for detached telemetry', async () => {
    await runAutoAgentMode(
      'review this',
      'review this with context',
      {
        taskType: 'review',
        executionStrategy: 'sequential',
        confidence: 0.9,
      } as never,
      vi.fn(),
      { provider: 'mock', model: 'mock-model' } as never,
      {
        workingDirectory: '/tmp/project',
        sessionId: 'session-auto-1',
        taskListManager: makeTaskListManager() as never,
        generateId: () => 'message-1',
        addMessage: vi.fn(),
        sendDAGStatusEvent: vi.fn(),
        runStandardAgentLoop: vi.fn(),
      },
      'session-auto-1',
    );

    expect(coordinatorState.capturedContext).toMatchObject({
      sessionId: 'session-auto-1',
      toolContext: {
        sessionId: 'session-auto-1',
        workingDirectory: '/tmp/project',
      },
    });
  });
});
