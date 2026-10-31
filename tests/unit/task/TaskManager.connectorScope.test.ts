import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

const sessionManagerState = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
  updateMessage: vi.fn(),
  getSession: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  db: {
    isReady: true,
    updateSession: vi.fn(),
  },
}));

const orchestratorMocks = vi.hoisted(() => ({
  configs: [] as Array<{ onEvent: (event: unknown) => Promise<void> }>,
  sendMessage: vi.fn(),
  resumeExistingDurableRun: vi.fn(),
  interruptAndContinue: vi.fn(),
  cancel: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  setSessionId: vi.fn(),
  setPlanningService: vi.fn(),
  setMessages: vi.fn(),
  setWorkingDirectory: vi.fn(),
  setWorkspaceScopeAuthority: vi.fn(),
  handlePermissionResponse: vi.fn(),
  getPendingPermissionRequests: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    constructor(config: { onEvent: (event: unknown) => Promise<void> }) {
      orchestratorMocks.configs.push(config);
    }
    sendMessage = (...args: unknown[]) => orchestratorMocks.sendMessage(...args);
    resumeExistingDurableRun = (...args: unknown[]) => orchestratorMocks.resumeExistingDurableRun(...args);
    interruptAndContinue = (...args: unknown[]) => orchestratorMocks.interruptAndContinue(...args);
    cancel = () => orchestratorMocks.cancel();
    pause = () => orchestratorMocks.pause();
    resume = () => orchestratorMocks.resume();
    setSessionId = (...args: unknown[]) => orchestratorMocks.setSessionId(...args);
    setPlanningService = (...args: unknown[]) => orchestratorMocks.setPlanningService(...args);
    setMessages = (...args: unknown[]) => orchestratorMocks.setMessages(...args);
    setWorkingDirectory = (...args: unknown[]) => orchestratorMocks.setWorkingDirectory(...args);
    setWorkspaceScopeAuthority = (...args: unknown[]) => orchestratorMocks.setWorkspaceScopeAuthority(...args);
    handlePermissionResponse = (...args: unknown[]) => orchestratorMocks.handlePermissionResponse(...args);
    getPendingPermissionRequests = () => orchestratorMocks.getPendingPermissionRequests();
  },
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
  notificationService: {
    notifyNeedsInput: vi.fn(),
    notifyTaskComplete: vi.fn(),
  },
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/host/task/backgroundTaskSessionContext', () => ({
  getBackgroundTaskSessionContext: (sessionId: string) => sessionManagerState.getSession(sessionId),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

import { TaskManager } from '../../../src/host/task/TaskManager';

const persistedMessageSymbol = Symbol.for('code-agent.contextAssembly.persistedMessage');

describe('TaskManager forwards insufficient_scope connector_required (desktop/agentAppService path sink)', () => {
  beforeEach(() => {
    sessionManagerState.addMessageToSession.mockReset();
    sessionManagerState.updateMessage.mockReset();
    sessionManagerState.getSession.mockReset();
    dbState.db.isReady = true;
    dbState.db.updateSession.mockReset();
    for (const mock of Object.values(orchestratorMocks)) {
      if (typeof mock === 'function' && 'mockReset' in mock) mock.mockReset();
    }
    orchestratorMocks.configs.length = 0;
  });


  it('passes the card event, with requiredScope/helpUrl intact, to onAgentEvent', () => {
    const onAgentEvent = vi.fn();
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({ configService: {} as never, onAgentEvent });
    const event = {
      type: 'connector_required' as const,
      data: { connectors: [{ id: 'notion', source: 'selected' as const, reason: 'insufficient_scope', requiredScope: 'write', helpUrl: 'https://example.test/p' }] },
    };
    manager.emitAgentEventForSession('session-1', event);
    expect(onAgentEvent).toHaveBeenCalledWith('session-1', event);
  });
});
