// ============================================================================
// IPC Handlers Unit Tests
// 测试 IPC handler 的输入验证、返回格式、错误处理
// 不启动 Electron，通过 mock ipcMain 捕获注册的 handler 并直接调用
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMain } from 'electron';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// ---------------------------------------------------------------------------
// Mock ipcMain: 捕获 handler 注册，支持按 channel 调用
// ---------------------------------------------------------------------------

type HandlerFn = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function createMockIpcMain() {
  const handlers = new Map<string, HandlerFn>();

  const mock: IpcMain = {
    handle: vi.fn((channel: string, handler: HandlerFn) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
    // Extra methods to satisfy IpcMain interface
    addListener: vi.fn(),
    removeListener: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    listenerCount: vi.fn(),
    listeners: vi.fn(),
    rawListeners: vi.fn(),
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
    eventNames: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(),
  } as unknown as IpcMain;

  return {
    mock,
    handlers,
    /** 模拟 renderer invoke：找到注册的 handler 并调用 */
    async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for channel: ${channel}`);
      return handler({}, ...args) as Promise<T>;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

// Mock getSessionManager (session.ipc.ts 通过模块级函数获取)
vi.mock('../../../src/main/services', () => ({
  getSessionManager: () => ({
    listSessions: vi.fn().mockResolvedValue([
      { id: 'session-1', title: 'Test Session', createdAt: Date.now() },
    ]),
    createSession: vi.fn().mockImplementation((opts: Record<string, unknown>) => Promise.resolve({
      id: 'new-session-id',
      title: opts.title || 'New Session',
      createdAt: Date.now(),
      messages: [],
    })),
    restoreSession: vi.fn().mockImplementation((id: string) => {
      if (id === 'nonexistent') return Promise.resolve(null);
      return Promise.resolve({
        id,
        title: 'Restored Session',
        messages: [{ role: 'user', content: 'hello' }],
        workingDirectory: '/tmp/test',
      });
    }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    exportSession: vi.fn().mockResolvedValue({ id: 'session-1', messages: [] }),
    importSession: vi.fn().mockResolvedValue('imported-session-id'),
    setCurrentSession: vi.fn(),
    archiveSession: vi.fn().mockResolvedValue({ id: 'session-1', archived: true }),
    unarchiveSession: vi.fn().mockResolvedValue({ id: 'session-1', archived: false }),
  }),
}));

vi.mock('../../../src/main/memory/memoryService', () => ({
  getMemoryService: () => ({
    setContext: vi.fn(),
  }),
}));

vi.mock('../../../src/main/memory/memoryTriggerService', () => ({
  getMemoryTriggerService: () => ({
    onSessionStart: vi.fn().mockResolvedValue({ memories: [] }),
  }),
}));

vi.mock('../../../src/main/session/modelSessionState', () => ({
  getModelSessionState: () => ({
    setOverride: vi.fn(),
    getOverride: vi.fn().mockReturnValue(null),
    clearOverride: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import handlers (after mocks)
// ---------------------------------------------------------------------------

import { registerAgentHandlers } from '../../../src/main/ipc/agent.ipc';
import { registerSessionHandlers } from '../../../src/main/ipc/session.ipc';
import { registerSettingsHandlers } from '../../../src/main/ipc/settings.ipc';

// ===========================================================================
// Tests
// ===========================================================================

describe('IPC Handlers', () => {
  let ipc: ReturnType<typeof createMockIpcMain>;

  // -----------------------------------------------------------------------
  // 1. Agent handler validates sessionId / orchestrator presence
  // -----------------------------------------------------------------------
  describe('agent handler validates orchestrator presence', () => {
    beforeEach(() => {
      ipc = createMockIpcMain();
    });

    it('returns INTERNAL_ERROR when orchestrator is null and action is send', async () => {
      const getAppService = () => null;
      registerAgentHandlers(ipc.mock, getAppService as any);

      const request: IPCRequest = {
        action: 'send',
        payload: { content: 'hello' },
      };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.AGENT, request);

      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe('INTERNAL_ERROR');
      expect(response.error!.message).toContain('not initialized');
    });

    it('returns INTERNAL_ERROR when orchestrator is null and action is cancel', async () => {
      const getAppService = () => null;
      registerAgentHandlers(ipc.mock, getAppService as any);

      const request: IPCRequest = { action: 'cancel' };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.AGENT, request);

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INTERNAL_ERROR');
    });

    it('returns INVALID_ACTION for unknown action', async () => {
      const getAppService = () => null;
      registerAgentHandlers(ipc.mock, getAppService as any);

      const request: IPCRequest = { action: 'nonexistent_action' };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.AGENT, request);

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INVALID_ACTION');
      expect(response.error!.message).toContain('nonexistent_action');
    });

    it('returns success when orchestrator is available and action is send', async () => {
      const mockAppService = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      registerAgentHandlers(ipc.mock, () => mockAppService as any);

      const request: IPCRequest = {
        action: 'send',
        payload: { content: 'test message' },
      };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.AGENT, request);

      expect(response.success).toBe(true);
      expect(mockAppService.sendMessage).toHaveBeenCalledWith({ content: 'test message' });
    });

    it('normalizes rich envelope payload for send', async () => {
      const mockAppService = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      registerAgentHandlers(ipc.mock, () => mockAppService as any);

      const request: IPCRequest = {
        action: 'send',
        payload: {
          content: 'test message',
          sessionId: 'session-1',
          attachments: [{ id: 'att-1', type: 'file', category: 'text', name: 'a.txt', size: 1, mimeType: 'text/plain' }],
          options: { researchMode: true },
          context: {
            workingDirectory: '/tmp/work',
            routing: {
              mode: 'direct',
              targetAgentIds: ['agent-1'],
            },
          },
        },
      };

      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.AGENT, request);

      expect(response.success).toBe(true);
      expect(mockAppService.sendMessage).toHaveBeenCalledWith({
        content: 'test message',
        sessionId: 'session-1',
        attachments: [{ id: 'att-1', type: 'file', category: 'text', name: 'a.txt', size: 1, mimeType: 'text/plain' }],
        options: { researchMode: true },
        context: {
          workingDirectory: '/tmp/work',
          routing: {
            mode: 'direct',
            targetAgentIds: ['agent-1'],
          },
        },
      });
    });
  });

  // -----------------------------------------------------------------------
  // 2. Session handler creates session with valid params
  // -----------------------------------------------------------------------
  describe('session handler creates session with valid params', () => {
    beforeEach(() => {
      ipc = createMockIpcMain();
    });

    it('creates a session and returns it in IPCResponse format', async () => {
      const mockAppService = {
        createSession: vi.fn().mockResolvedValue({
          id: 'new-session-id',
          title: 'My Test Session',
          createdAt: Date.now(),
          messages: [],
        }),
      };

      registerSessionHandlers(ipc.mock, () => mockAppService as any);

      const request: IPCRequest = {
        action: 'create',
        payload: { title: 'My Test Session' },
      };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.SESSION, request);

      expect(response.success).toBe(true);
      expect(response.data).toBeDefined();
      expect((response.data as any).id).toBe('new-session-id');
    });

    it('returns error when services not initialized', async () => {
      registerSessionHandlers(ipc.mock, () => null as any);

      const request: IPCRequest = { action: 'create', payload: { title: 'Test' } };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.SESSION, request);

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INTERNAL_ERROR');
      expect(response.error!.message).toContain('not initialized');
    });
  });

  // -----------------------------------------------------------------------
  // 3. Settings handler returns config object (get action)
  // -----------------------------------------------------------------------
  describe('settings handler returns config object', () => {
    beforeEach(() => {
      ipc = createMockIpcMain();
    });

    it('returns settings via domain handler', async () => {
      const mockSettings = {
        model: { provider: 'openai', model: 'gpt-4' },
        theme: 'dark',
      };
      const getConfigService = () => ({
        getSettings: () => mockSettings,
      });

      registerSettingsHandlers(ipc.mock, getConfigService as any);

      const request: IPCRequest = { action: 'get' };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.SETTINGS, request);

      expect(response.success).toBe(true);
      expect(response.data).toEqual(mockSettings);
    });

    it('returns error when configService is null', async () => {
      registerSettingsHandlers(ipc.mock, () => null);

      const request: IPCRequest = { action: 'get' };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.SETTINGS, request);

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INTERNAL_ERROR');
      expect(response.error!.message).toContain('not initialized');
    });

    it('handles set action successfully', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      const getConfigService = () => ({
        getSettings: () => ({}),
        updateSettings,
      });

      registerSettingsHandlers(ipc.mock, getConfigService as any);

      const request: IPCRequest = {
        action: 'set',
        payload: { settings: { theme: 'light' } },
      };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.SETTINGS, request);

      expect(response.success).toBe(true);
      expect(updateSettings).toHaveBeenCalledWith({ theme: 'light' });
    });
  });

  // -----------------------------------------------------------------------
  // 4. Handlers return error for invalid input (not crash)
  // -----------------------------------------------------------------------
  describe('handlers return error for invalid input', () => {
    beforeEach(() => {
      ipc = createMockIpcMain();
    });

    it('agent: unknown action returns INVALID_ACTION, not crash', async () => {
      registerAgentHandlers(ipc.mock, () => null as any);

      const request: IPCRequest = { action: 'destroy_everything' };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.AGENT, request);

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INVALID_ACTION');
      // Should NOT throw - the handler catches and returns structured error
    });

    it('session: unknown action returns INVALID_ACTION', async () => {
      const mockAppService = { listSessions: vi.fn() };
      registerSessionHandlers(ipc.mock, () => mockAppService as any);

      const request: IPCRequest = { action: 'teleport' };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.SESSION, request);

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INVALID_ACTION');
    });

    it('settings: unknown action returns INVALID_ACTION', async () => {
      registerSettingsHandlers(ipc.mock, () => null);

      const request: IPCRequest = { action: 'hack_the_planet' };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.SETTINGS, request);

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INVALID_ACTION');
    });

    it('session: load with nonexistent sessionId returns error', async () => {
      const mockAppService = {
        loadSession: vi.fn().mockRejectedValue(new Error('Session not found')),
      };
      registerSessionHandlers(ipc.mock, () => mockAppService as any);

      const request: IPCRequest = {
        action: 'load',
        payload: { sessionId: 'nonexistent' },
      };
      const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.SESSION, request);

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INTERNAL_ERROR');
      expect(response.error!.message).toContain('not found');
    });
  });

  // -----------------------------------------------------------------------
  // 5. All registered channels match type definitions
  // -----------------------------------------------------------------------
  describe('all registered channels match type definitions', () => {
    it('agent handler registers domain channel', () => {
      ipc = createMockIpcMain();
      registerAgentHandlers(ipc.mock, () => null as any);

      expect(ipc.handlers.has(IPC_DOMAINS.AGENT)).toBe(true);
    });

    it('session handler registers domain channel', () => {
      ipc = createMockIpcMain();
      registerSessionHandlers(ipc.mock, () => null as any);

      expect(ipc.handlers.has(IPC_DOMAINS.SESSION)).toBe(true);
    });

    it('settings handler registers domain and window channels', () => {
      ipc = createMockIpcMain();
      registerSettingsHandlers(ipc.mock, () => null);

      expect(ipc.handlers.has(IPC_DOMAINS.SETTINGS)).toBe(true);
      expect(ipc.handlers.has(IPC_DOMAINS.WINDOW)).toBe(true);
    });

    it('all domain channels use "domain:" prefix convention', () => {
      const domainValues = Object.values(IPC_DOMAINS);
      for (const channel of domainValues) {
        expect(channel).toMatch(/^domain:/);
      }
    });

    it('IPCResponse shape is consistent across handlers', async () => {
      ipc = createMockIpcMain();
      registerAgentHandlers(ipc.mock, () => null as any);
      registerSessionHandlers(ipc.mock, () => null as any);
      registerSettingsHandlers(ipc.mock, () => null);

      // Invoke all three with invalid actions and verify response shape
      const domains = [IPC_DOMAINS.AGENT, IPC_DOMAINS.SESSION, IPC_DOMAINS.SETTINGS];
      for (const domain of domains) {
        const request: IPCRequest = { action: '__invalid__' };
        const response = await ipc.invoke<IPCResponse>(domain, request);

        // Every response must have 'success' boolean
        expect(typeof response.success).toBe('boolean');
        // Error responses must have error.code and error.message
        if (!response.success) {
          expect(response.error).toBeDefined();
          expect(typeof response.error!.code).toBe('string');
          expect(typeof response.error!.message).toBe('string');
        }
      }
    });
  });
});
