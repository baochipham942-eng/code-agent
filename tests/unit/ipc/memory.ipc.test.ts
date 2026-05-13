import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCResponse } from '../../../src/shared/ipc';
import type { MemoryRecord } from '../../../src/main/services/core/repositories';

const mocks = vi.hoisted(() => ({
  database: {
    listMemories: vi.fn(),
  },
  getDatabase: vi.fn(),
  getSessionManager: vi.fn(),
  listMemoryFiles: vi.fn(),
  readMemoryFile: vi.fn(),
  deleteMemoryFile: vi.fn(),
  getLightMemoryStats: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../../src/main/services', () => ({
  getDatabase: mocks.getDatabase,
  getSessionManager: mocks.getSessionManager,
}));

vi.mock('../../../src/main/lightMemory/lightMemoryIpc', () => ({
  listMemoryFiles: mocks.listMemoryFiles,
  readMemoryFile: mocks.readMemoryFile,
  deleteMemoryFile: mocks.deleteMemoryFile,
  getLightMemoryStats: mocks.getLightMemoryStats,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { registerMemoryHandlers } from '../../../src/main/ipc/memory.ipc';

type HandlerFn = (event: unknown, request: unknown) => Promise<unknown>;

function createMockIpcMain() {
  const handlers = new Map<string, HandlerFn>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: HandlerFn) => {
        handlers.set(channel, handler);
      }),
    },
    invoke<T>(channel: string, request: unknown): Promise<T> {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for ${channel}`);
      return handler({}, request) as Promise<T>;
    },
  };
}

function memory(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'mem-default',
    type: 'project_knowledge',
    category: 'decision',
    content: 'Default memory',
    summary: 'Default',
    source: 'session_extracted',
    projectPath: '/repo/code-agent',
    sessionId: 'session-1',
    confidence: 0.8,
    metadata: {},
    accessCount: 0,
    createdAt: 1778664000000,
    updatedAt: 1778664000000,
    ...overrides,
  };
}

describe('memory.ipc memoryAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue(mocks.database);
    mocks.listMemoryFiles.mockResolvedValue([
      {
        filename: 'project_rules.md',
        name: 'Project Rules',
        description: 'Follow project rules',
        type: 'project',
        content: 'Use existing UI patterns.',
        updatedAt: '2026-05-13T12:00:00.000Z',
      },
    ]);
    mocks.getLightMemoryStats.mockResolvedValue({
      totalFiles: 1,
      byType: { project: 1 },
      sessionStats: null,
      recentConversations: [
        '- **2026-05-13**: "Memory audit" — Light Memory',
      ],
    });
  });

  it('returns a read-only audit payload from Light Memory, stored memories, and seed candidates', async () => {
    const dbMemory = memory({
      id: 'mem-project',
      content: '入口必须放在左下角展开菜单栏里',
      summary: '左下角菜单入口',
      confidence: 0.91,
      accessCount: 2,
      lastAccessedAt: 1778665000000,
      metadata: { source: 'test' },
    });
    const globalPreference = memory({
      id: 'mem-preference',
      type: 'user_preference',
      category: 'preference',
      content: '用户偏好中文回复',
      source: 'user_defined',
      projectPath: undefined,
      sessionId: undefined,
      confidence: 1,
      updatedAt: 1778664100000,
    });
    const desktopActivity = memory({
      id: 'mem-desktop',
      type: 'desktop_activity',
      category: 'activity',
      content: 'Frontmost app changed',
    });
    const seedHigh = memory({
      id: 'mem-seed-high',
      content: '当前项目知识更相关',
      confidence: 0.95,
      updatedAt: 1778664300000,
    });
    const seedLow = memory({
      id: 'mem-seed-low',
      content: '低置信度项目知识',
      confidence: 0.5,
      updatedAt: 1778664400000,
    });

    mocks.database.listMemories
      .mockReturnValueOnce([dbMemory, globalPreference, desktopActivity])
      .mockReturnValueOnce([seedLow, desktopActivity, seedHigh]);

    const ipc = createMockIpcMain();
    registerMemoryHandlers(ipc.ipcMain as never);

    const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.MEMORY, {
      action: 'memoryAudit',
      payload: {
        projectPath: ' /repo/code-agent ',
        sessionId: ' session-1 ',
        limit: 500,
      },
    });

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
      lightFiles: [
        expect.objectContaining({ filename: 'project_rules.md' }),
      ],
      lightStats: expect.objectContaining({ totalFiles: 1 }),
    });

    const data = response.data as {
      databaseMemories: Array<{ id: string; projectPath: string | null; sessionId: string | null }>;
      seedCandidates: Array<{ id: string }>;
    };
    expect(data.databaseMemories.map((item) => item.id)).toEqual(['mem-project', 'mem-preference']);
    expect(data.databaseMemories[1]).toMatchObject({
      projectPath: null,
      sessionId: null,
    });
    expect(data.seedCandidates.map((item) => item.id)).toEqual(['mem-seed-high', 'mem-seed-low']);
    expect(mocks.database.listMemories).toHaveBeenNthCalledWith(1, {
      limit: 200,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });
    expect(mocks.database.listMemories).toHaveBeenNthCalledWith(2, {
      projectPath: '/repo/code-agent',
      limit: 30,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });
  });

  it('keeps audit available when the database read fails', async () => {
    mocks.getDatabase.mockImplementation(() => {
      throw new Error('database unavailable');
    });

    const ipc = createMockIpcMain();
    registerMemoryHandlers(ipc.ipcMain as never);

    const response = await ipc.invoke<IPCResponse>(IPC_CHANNELS.MEMORY, {
      action: 'memoryAudit',
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        projectPath: '/repo/code-agent',
        sessionId: 'session-1',
        databaseMemories: [],
        seedCandidates: [],
        lightStats: expect.objectContaining({ totalFiles: 1 }),
      },
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Memory audit database read skipped',
      { error: 'database unavailable' },
    );
  });
});
