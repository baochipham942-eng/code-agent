import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';

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
  sendMessage: vi.fn(),
  interruptAndContinue: vi.fn(),
  cancel: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  setSessionId: vi.fn(),
  setPlanningService: vi.fn(),
  setMessages: vi.fn(),
  setWorkingDirectory: vi.fn(),
  handlePermissionResponse: vi.fn(),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/main/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    sendMessage = (...args: unknown[]) => orchestratorMocks.sendMessage(...args);
    interruptAndContinue = (...args: unknown[]) => orchestratorMocks.interruptAndContinue(...args);
    cancel = () => orchestratorMocks.cancel();
    pause = () => orchestratorMocks.pause();
    resume = () => orchestratorMocks.resume();
    setSessionId = (...args: unknown[]) => orchestratorMocks.setSessionId(...args);
    setPlanningService = (...args: unknown[]) => orchestratorMocks.setPlanningService(...args);
    setMessages = (...args: unknown[]) => orchestratorMocks.setMessages(...args);
    setWorkingDirectory = (...args: unknown[]) => orchestratorMocks.setWorkingDirectory(...args);
    handlePermissionResponse = (...args: unknown[]) => orchestratorMocks.handlePermissionResponse(...args);
  },
}));

vi.mock('../../../src/main/platform', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../../src/main/services', () => ({
  getSessionManager: () => sessionManagerState,
  notificationService: {
    notifyNeedsInput: vi.fn(),
    notifyTaskComplete: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

import { TaskManager } from '../../../src/main/task/TaskManager';

const persistedMessageSymbol = Symbol.for('code-agent.contextAssembly.persistedMessage');

describe('TaskManager message event persistence', () => {
  beforeEach(() => {
    sessionManagerState.addMessageToSession.mockReset();
    sessionManagerState.updateMessage.mockReset();
    sessionManagerState.getSession.mockReset();
    dbState.db.isReady = true;
    dbState.db.updateSession.mockReset();
    for (const mock of Object.values(orchestratorMocks)) {
      mock.mockReset();
    }
  });

  it('does not insert a message event already persisted by ContextAssembly, while keeping tool result updates', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    const message: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'using a tool',
      timestamp: 100,
      toolCalls: [{
        id: 'tool-1',
        name: 'Read',
        arguments: { path: '/tmp/file.txt' },
      }],
    };
    Object.defineProperty(message, persistedMessageSymbol, {
      value: true,
      enumerable: false,
    });

    await (manager as any).persistEventToSession('session-1', {
      type: 'message',
      data: message,
    });

    expect(sessionManagerState.addMessageToSession).not.toHaveBeenCalled();

    await (manager as any).persistEventToSession('session-1', {
      type: 'tool_call_end',
      data: {
        toolCallId: 'tool-1',
        success: true,
        output: 'file content',
        duration: 5,
      },
    });

    expect(sessionManagerState.updateMessage).toHaveBeenCalledWith('assistant-1', {
      toolCalls: [{
        id: 'tool-1',
        name: 'Read',
        arguments: { path: '/tmp/file.txt' },
        result: {
          toolCallId: 'tool-1',
          success: true,
          output: 'file content',
          duration: 5,
        },
      }],
    });
  });

  it('cancels an active task without emitting task_completed', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({
      configService: {} as never,
      onAgentEvent: vi.fn(),
    });

    let resolveSendMessage: (() => void) | undefined;
    orchestratorMocks.sendMessage.mockImplementation(() => new Promise<void>((resolve) => {
      resolveSendMessage = resolve;
    }));
    orchestratorMocks.cancel.mockImplementation(async () => {
      resolveSendMessage?.();
    });

    const events: string[] = [];
    manager.on('event', (event) => events.push(event.type));

    const runPromise = manager.startTask('session-cancel', 'long task');
    await vi.waitFor(() => {
      expect(orchestratorMocks.sendMessage).toHaveBeenCalled();
    });

    await manager.cancelTask('session-cancel');
    await runPromise;

    expect(events).toContain('task_cancelled');
    expect(events).not.toContain('task_completed');
    expect(manager.getSessionState('session-cancel').status).toBe('idle');
  });

  it('reflects pause and resume in TaskManager state', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({
      configService: {} as never,
      onAgentEvent: vi.fn(),
    });

    let resolveSendMessage: (() => void) | undefined;
    orchestratorMocks.sendMessage.mockImplementation(() => new Promise<void>((resolve) => {
      resolveSendMessage = resolve;
    }));
    orchestratorMocks.cancel.mockImplementation(async () => {
      resolveSendMessage?.();
    });

    const runPromise = manager.startTask('session-pause', 'pause task');
    await vi.waitFor(() => {
      expect(orchestratorMocks.sendMessage).toHaveBeenCalled();
    });

    expect(manager.pauseTask('session-pause')).toBe(true);
    expect(orchestratorMocks.pause).toHaveBeenCalled();
    expect(manager.getSessionState('session-pause').status).toBe('paused');

    expect(manager.resumeTask('session-pause')).toBe(true);
    expect(orchestratorMocks.resume).toHaveBeenCalled();
    expect(manager.getSessionState('session-pause').status).toBe('running');
    expect(dbState.db.updateSession).toHaveBeenCalledWith(
      'session-pause',
      expect.objectContaining({ status: 'running' }),
    );

    await manager.cancelTask('session-pause');
    await runPromise;
  });

  it('passes run options and message metadata through the TaskManager-owned send path', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({
      configService: {} as never,
      onAgentEvent: vi.fn(),
    });

    const options = { toolScope: { allowedSkillIds: ['docx'] } } as never;
    const metadata = { workbench: { workingDirectory: '/tmp/project' } } as never;

    await manager.startTask('session-options', 'hello', ['attachment'], options, metadata);

    expect(orchestratorMocks.sendMessage).toHaveBeenCalledWith(
      'hello',
      ['attachment'],
      options,
      metadata,
    );
    expect(manager.getSessionState('session-options').status).toBe('idle');
  });

  it('routes interrupt-and-continue through the active TaskManager orchestrator', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({
      configService: {} as never,
      onAgentEvent: vi.fn(),
    });

    let resolveSendMessage: (() => void) | undefined;
    orchestratorMocks.sendMessage.mockImplementation(() => new Promise<void>((resolve) => {
      resolveSendMessage = resolve;
    }));
    orchestratorMocks.interruptAndContinue.mockResolvedValue(undefined);

    const runPromise = manager.startTask('session-interrupt', 'long task');
    await vi.waitFor(() => {
      expect(orchestratorMocks.sendMessage).toHaveBeenCalled();
    });

    const options = { executionIntent: { allowBrowserAutomation: false } } as never;
    const metadata = { workbench: { executionIntent: { allowBrowserAutomation: false } } } as never;
    await manager.interruptAndContinue(
      'session-interrupt',
      'new instruction',
      [],
      options,
      metadata,
      'client-msg-1',
    );

    expect(orchestratorMocks.interruptAndContinue).toHaveBeenCalledWith(
      'new instruction',
      [],
      options,
      metadata,
      'client-msg-1',
    );
    expect(manager.getSessionState('session-interrupt').status).toBe('running');

    resolveSendMessage?.();
    await runPromise;
  });

  it('recovers an orphaned running state before starting an interrupt as a fresh task', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({
      configService: {} as never,
      onAgentEvent: vi.fn(),
    });
    (manager as any).updateSessionState('session-orphan', { status: 'running' });

    await manager.interruptAndContinue('session-orphan', 'fresh task');

    expect(orchestratorMocks.sendMessage).toHaveBeenCalledWith(
      'fresh task',
      undefined,
      undefined,
      undefined,
    );
    expect(manager.getSessionState('session-orphan').status).toBe('idle');
  });
});
