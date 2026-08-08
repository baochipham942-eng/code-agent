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
  configs: [] as Array<{ onEvent: (event: unknown) => Promise<void> }>,
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

describe('TaskManager message event persistence', () => {
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

  it('excludes auxiliary meta history when rehydrating the foreground orchestrator', () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'start task', timestamp: 1 },
      {
        id: 'assistant-spawn',
        role: 'assistant',
        content: 'starting',
        timestamp: 2,
        toolCalls: [{ id: 'call-spawn', name: 'delegate_task', arguments: {} }],
      },
      { id: 'child-prompt', role: 'user', content: 'child work', timestamp: 3, isMeta: true },
      {
        id: 'spawn-result',
        role: 'tool',
        content: 'accepted',
        timestamp: 4,
        toolResults: [{ toolCallId: 'call-spawn', success: true, output: 'accepted' }],
      },
      { id: 'rewound', role: 'assistant', content: 'old branch', timestamp: 5, visibility: 'rewound' },
    ];

    manager.setSessionContext('session-1', messages);

    expect(orchestratorMocks.setMessages).toHaveBeenCalledWith([
      messages[0],
      messages[1],
      messages[3],
    ]);
  });

  it('runs two auxiliary tasks in one session and cancels only the addressed task', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
    sessionManagerState.getSession.mockResolvedValue({
      messages: [],
      workingDirectory: '/tmp/project',
    });
    const resolvers: Array<() => void> = [];
    orchestratorMocks.sendMessage.mockImplementation(() => new Promise<void>((resolve) => {
      resolvers.push(resolve);
    }));
    orchestratorMocks.cancel.mockResolvedValue(undefined);
    const events: Array<{ type: string; data?: { taskId?: string } }> = [];
    manager.on('event', (event) => events.push(event));

    const first = manager.startBackgroundTask('task-1', 'session-1', 'first');
    const second = manager.startBackgroundTask('task-2', 'session-1', 'second');
    await vi.waitFor(() => expect(orchestratorMocks.sendMessage).toHaveBeenCalledTimes(2));

    expect(orchestratorMocks.setWorkingDirectory).toHaveBeenNthCalledWith(
      1,
      '/tmp/project',
      { syncWorkspaceServices: false },
    );
    expect(orchestratorMocks.setWorkingDirectory).toHaveBeenNthCalledWith(
      2,
      '/tmp/project',
      { syncWorkspaceServices: false },
    );
    expect(orchestratorMocks.sendMessage.mock.calls[0][2]).toMatchObject({
      runRegistration: 'auxiliary',
      historyVisibility: 'meta',
      disableAutoAgent: true,
      deniedToolNames: expect.arrayContaining(['Task', 'TaskManager', 'spawn_agent', 'AgentSpawn']),
      turnSystemContext: expect.arrayContaining([
        expect.stringContaining('第一步直接调用'),
      ]),
    });
    expect(orchestratorMocks.sendMessage.mock.calls[1][2]).toMatchObject({
      runRegistration: 'auxiliary',
      historyVisibility: 'meta',
      disableAutoAgent: true,
      deniedToolNames: expect.arrayContaining(['Task', 'TaskManager', 'spawn_agent', 'AgentSpawn']),
    });
    expect(await manager.cancelBackgroundTask('task-1')).toBe(true);
    expect(manager.getBackgroundTaskState('task-1')).toEqual({ sessionId: 'session-1', status: 'cancelling' });
    expect(manager.getBackgroundTaskState('task-2')).toEqual({ sessionId: 'session-1', status: 'running' });

    resolvers[0]?.();
    resolvers[1]?.();
    await Promise.all([first, second]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'task_cancelled', data: { taskId: 'task-1' } }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'task_completed', data: { taskId: 'task-2' } }));
  });

  it('routes a background permission response to its exact auxiliary orchestrator', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
    sessionManagerState.getSession.mockResolvedValue({ messages: [] });
    let resolveRun: (() => void) | undefined;
    orchestratorMocks.sendMessage.mockImplementation(() => new Promise<void>((resolve) => {
      resolveRun = resolve;
    }));
    orchestratorMocks.handlePermissionResponse.mockReturnValue('delivered');

    const run = manager.startBackgroundTask('task-permission', 'session-1', 'needs approval');
    await vi.waitFor(() => expect(orchestratorMocks.configs).toHaveLength(1));
    await orchestratorMocks.configs[0].onEvent({
      type: 'permission_request',
      data: {
        id: 'request-1',
        sessionId: 'session-1',
        type: 'command',
        tool: 'Bash',
        details: { command: 'true' },
        timestamp: 1,
      },
    });

    expect(manager.handlePermissionResponse('session-1', 'request-1', 'allow')).toBe('delivered');
    expect(orchestratorMocks.handlePermissionResponse).toHaveBeenCalledWith('request-1', 'allow');
    resolveRun?.();
    await run;
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

  it('emits a final main-accumulator snapshot before turn_end without writing every delta', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    const onAgentEvent = vi.fn();
    manager.initialize({
      configService: {} as never,
      onAgentEvent,
    });

    await (manager as any).handleAgentEvent('session-1', {
      type: 'turn_start',
      data: { turnId: 'turn-1' },
    });
    await (manager as any).handleAgentEvent('session-1', {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'hello ',
        turnId: 'turn-1',
        messageId: 'turn-1',
      },
    });
    await (manager as any).handleAgentEvent('session-1', {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'world',
        turnId: 'turn-1',
        messageId: 'turn-1',
      },
    });

    expect(sessionManagerState.addMessageToSession).not.toHaveBeenCalled();
    expect(sessionManagerState.updateMessage).not.toHaveBeenCalled();

    await (manager as any).handleAgentEvent('session-1', {
      type: 'turn_end',
      data: { turnId: 'turn-1' },
    });

    expect(onAgentEvent).toHaveBeenCalledWith('session-1', {
      type: 'message_snapshot',
      data: expect.objectContaining({
        role: 'assistant',
        turnId: 'turn-1',
        messageId: 'turn-1',
        content: 'hello world',
        isFinal: true,
        source: 'main_accumulator',
      }),
    });
    const calls = onAgentEvent.mock.calls.map((call) => call[1].type);
    expect(calls.indexOf('message_snapshot')).toBeLessThan(calls.indexOf('turn_end'));
  });

  it('drops duplicate sequenced message deltas before renderer and persistence', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    const onAgentEvent = vi.fn();
    manager.initialize({
      configService: {} as never,
      onAgentEvent,
    });

    await (manager as any).handleAgentEvent('session-1', {
      type: 'turn_start',
      data: { turnId: 'turn-1' },
    });
    const delta = {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'hello ',
        turnId: 'turn-1',
        messageId: 'turn-1',
        deltaSeq: 1,
      },
    };
    await (manager as any).handleAgentEvent('session-1', delta);
    await (manager as any).handleAgentEvent('session-1', delta);
    await (manager as any).handleAgentEvent('session-1', {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'world',
        turnId: 'turn-1',
        messageId: 'turn-1',
        deltaSeq: 2,
      },
    });
    await (manager as any).handleAgentEvent('session-1', {
      type: 'turn_end',
      data: { turnId: 'turn-1' },
    });

    const forwardedDeltas = onAgentEvent.mock.calls
      .map((call) => call[1])
      .filter((event) => event.type === 'message_delta');
    expect(forwardedDeltas).toHaveLength(2);
    expect(onAgentEvent).toHaveBeenCalledWith('session-1', {
      type: 'message_snapshot',
      data: expect.objectContaining({
        content: 'hello world',
        isFinal: true,
      }),
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

  it('persists idle to DB after a successful run (aligned with engine adapters)', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({
      configService: {} as never,
      onAgentEvent: vi.fn(),
    });
    orchestratorMocks.sendMessage.mockResolvedValue(undefined);

    await manager.startTask('session-success', 'quick task');

    const persistedStatuses = dbState.db.updateSession.mock.calls.map(
      (call) => (call[1] as { status?: string }).status,
    );
    expect(persistedStatuses).toEqual(['running', 'idle']);
    expect(manager.getSessionState('session-success').status).toBe('idle');
  });

  it('keeps the failed terminal status in DB when the in-memory state settles back to idle', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({
      configService: {} as never,
      onAgentEvent: vi.fn(),
    });
    orchestratorMocks.sendMessage.mockRejectedValue(new Error('model exploded'));

    await manager.startTask('session-failure', 'failing task');

    // 内存归位 idle（任务槽释放，会话可复用）……
    expect(manager.getSessionState('session-failure').status).toBe('idle');
    // ……但 DB 必须留住 'error'，重启后侧栏才把该会话分类为「出错」而不是误显示「已完成」。
    const persistedStatuses = dbState.db.updateSession.mock.calls.map(
      (call) => (call[1] as { status?: string }).status,
    );
    expect(persistedStatuses).toEqual(['running', 'error', 'error']);
    expect(persistedStatuses).not.toContain('idle');
    expect(dbState.db.updateSession).toHaveBeenLastCalledWith(
      'session-failure',
      expect.objectContaining({ status: 'error' }),
    );
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

    await manager.startTask('session-options', 'hello', ['attachment'], options, metadata, 'client-msg-options');

    expect(orchestratorMocks.sendMessage).toHaveBeenCalledWith(
      'hello',
      ['attachment'],
      options,
      metadata,
      'client-msg-options',
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
    const expectedOutcome = { outcome: 'queued', queuedInputId: 'queued-input-x' } as const;
    orchestratorMocks.interruptAndContinue.mockResolvedValue(expectedOutcome);

    const runPromise = manager.startTask('session-interrupt', 'long task');
    await vi.waitFor(() => {
      expect(orchestratorMocks.sendMessage).toHaveBeenCalled();
    });

    const options = { executionIntent: { allowBrowserAutomation: false } } as never;
    const metadata = { workbench: { executionIntent: { allowBrowserAutomation: false } } } as never;
    const outcome = await manager.interruptAndContinue(
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
    expect(outcome).toBe(expectedOutcome);
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

    const outcome = await manager.interruptAndContinue('session-orphan', 'fresh task');

    expect(orchestratorMocks.sendMessage).toHaveBeenCalledWith(
      'fresh task',
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(outcome).toEqual({ outcome: 'steered' });
    expect(manager.getSessionState('session-orphan').status).toBe('idle');
  });

  it('returns steered after replacing a queued task with a fresh task', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
    (manager as any).updateSessionState('session-queued', { status: 'queued' });
    vi.spyOn(manager, 'cancelTask').mockResolvedValue(undefined);
    vi.spyOn(manager, 'startTask').mockResolvedValue(undefined);

    await expect(manager.interruptAndContinue('session-queued', 'replacement')).resolves.toEqual({
      outcome: 'steered',
    });
  });

  it('returns steered after starting an interrupt request from idle', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
    vi.spyOn(manager, 'startTask').mockResolvedValue(undefined);

    await expect(manager.interruptAndContinue('session-idle', 'fresh task')).resolves.toEqual({
      outcome: 'steered',
    });
  });
});
