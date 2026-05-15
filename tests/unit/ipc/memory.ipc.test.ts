import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCResponse } from '../../../src/shared/ipc';
import type { MemoryRecord } from '../../../src/main/services/core/repositories';

const mocks = vi.hoisted(() => ({
  database: {
    listMemories: vi.fn(),
    createMemory: vi.fn(),
    updateMemory: vi.fn(),
  },
  getDatabase: vi.fn(),
  getSessionManager: vi.fn(),
  listMemoryFiles: vi.fn(),
  readMemoryFile: vi.fn(),
  deleteMemoryFile: vi.fn(),
  getLightMemoryStats: vi.fn(),
  getLightMemoryHealth: vi.fn(),
  rebuildLightMemoryIndex: vi.fn(),
  writeLightMemoryFile: vi.fn(),
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
  getLightMemoryHealth: mocks.getLightMemoryHealth,
  rebuildLightMemoryIndex: mocks.rebuildLightMemoryIndex,
  writeLightMemoryFile: mocks.writeLightMemoryFile,
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
import {
  clearMemoryInjectionTracesForTest,
  recordMemoryInjectionTrace,
} from '../../../src/main/memory/memoryInjectionTrace';
import { hashInboxContent } from '../../../src/main/memory/knowledgeInboxDecision';

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
    clearMemoryInjectionTracesForTest();
    mocks.getDatabase.mockReturnValue(mocks.database);
    mocks.database.createMemory.mockImplementation((data: Partial<MemoryRecord>) => memory({
      id: `mem-created-${mocks.database.createMemory.mock.calls.length}`,
      ...data,
      accessCount: 0,
      createdAt: 1778666000000,
      updatedAt: 1778666000000,
    }));
    mocks.database.updateMemory.mockImplementation((id: string, data: Partial<MemoryRecord>) => memory({
      id,
      ...data,
      accessCount: 0,
      createdAt: 1778666000000,
      updatedAt: 1778666000001,
    }));
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
    mocks.getLightMemoryHealth.mockResolvedValue({
      totalFiles: 1,
      indexExists: true,
      indexLineCount: 3,
      indexTooLong: false,
      missingInIndex: [],
      orphanInIndex: [],
      invalidFrontmatter: [],
      unreadableFiles: [],
      duplicateNames: [],
      duplicateDescriptions: [],
    });
    mocks.rebuildLightMemoryIndex.mockResolvedValue({
      indexPath: '/tmp/memory/INDEX.md',
      totalFiles: 1,
      indexedFiles: 1,
      skippedFiles: [],
    });
    mocks.writeLightMemoryFile.mockImplementation(async (input: {
      filename: string;
      name: string;
      description: string;
      type: string;
      content: string;
      entryId?: string;
      status?: string;
      source?: string;
      schemaVersion?: number;
    }) => ({
      filename: input.filename,
      name: input.name,
      description: input.description,
      type: input.type,
      content: input.content,
      entryId: input.entryId,
      status: input.status,
      source: input.source,
      schemaVersion: input.schemaVersion,
      updatedAt: '2026-05-13T12:30:00.000Z',
    }));
  });

  it('returns a read-only audit payload from Light Memory, stored memories, and seed candidates', async () => {
    recordMemoryInjectionTrace({
      blockType: 'memory_index',
      trigger: 'memory_intent',
      chars: 120,
      injected: true,
      source: 'light-memory-index',
      count: 3,
      sessionId: 'session-1',
      timestamp: 1778665200000,
    });
    recordMemoryInjectionTrace({
      blockType: 'memory_hint',
      trigger: 'default_memory_hint',
      chars: 93,
      injected: true,
      source: 'light-memory-tool-hint',
      count: 1,
      sessionId: 'other-session',
      timestamp: 1778665300000,
    });
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
      .mockReturnValueOnce([
        memory({
          id: 'mem-inbox-decision',
          type: 'desktop_activity',
          category: 'knowledge_inbox_decision',
          content: 'Rejected Knowledge Inbox candidate: 左下角菜单入口',
          summary: '忽略: 左下角菜单入口',
          source: 'user_defined',
          metadata: {
            knowledgeInbox: {
              candidateId: 'flush:mem-project',
              decision: 'reject',
              contentHash: 'abc123',
              title: '左下角菜单入口',
              kind: '候选项目知识',
              source: '压缩前提取',
              reason: '需要确认',
              decidedAt: 1778665400000,
              memoryId: null,
            },
          },
        }),
        memory({
          id: 'mem-seed-decision',
          type: 'desktop_activity',
          category: 'knowledge_inbox_decision',
          content: 'Rejected Knowledge Inbox candidate: 当前项目知识更相关',
          summary: '忽略: 当前项目知识更相关',
          source: 'user_defined',
          metadata: {
            knowledgeInbox: {
              candidateId: 'flush:mem-seed-high',
              decision: 'reject',
              contentHash: hashInboxContent('当前项目知识更相关'),
              title: '当前项目知识更相关',
              kind: '候选项目知识',
              source: '压缩前提取',
              reason: '需要确认',
              decidedAt: 1778665500000,
              memoryId: null,
            },
          },
        }),
      ])
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
      inboxDecisions: Array<{ candidateId: string; decision: string; contentHash: string; decisionMemoryId: string }>;
      injectionTraces: Array<{ blockType: string; trigger: string; chars: number; injected: boolean; source: string; count: number; sessionId: string }>;
    };
    expect(data.databaseMemories.map((item) => item.id)).toEqual(['mem-project', 'mem-preference']);
    expect(data.databaseMemories[1]).toMatchObject({
      projectPath: null,
      sessionId: null,
    });
    expect(data.seedCandidates.map((item) => item.id)).toEqual(['mem-seed-low']);
    expect(data.inboxDecisions).toEqual([
      expect.objectContaining({
        candidateId: 'flush:mem-project',
        decision: 'reject',
        contentHash: 'abc123',
        decisionMemoryId: 'mem-inbox-decision',
      }),
      expect.objectContaining({
        candidateId: 'flush:mem-seed-high',
        decision: 'reject',
        contentHash: hashInboxContent('当前项目知识更相关'),
        decisionMemoryId: 'mem-seed-decision',
      }),
    ]);
    expect(data.injectionTraces).toEqual([
      expect.objectContaining({
        blockType: 'memory_index',
        trigger: 'memory_intent',
        chars: 120,
        injected: true,
        source: 'light-memory-index',
        count: 3,
        sessionId: 'session-1',
      }),
    ]);
    expect(mocks.database.listMemories).toHaveBeenNthCalledWith(1, {
      limit: 200,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });
    expect(mocks.database.listMemories).toHaveBeenNthCalledWith(2, {
      category: 'knowledge_inbox_decision',
      projectPath: '/repo/code-agent',
      limit: 100,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });
    expect(mocks.database.listMemories).toHaveBeenNthCalledWith(3, {
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
        inboxDecisions: [],
        injectionTraces: [],
        lightStats: expect.objectContaining({ totalFiles: 1 }),
      },
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Memory audit database read skipped',
      { error: 'database unavailable' },
    );
  });

  it('routes lightHealth through the domain memory handler', async () => {
    const ipc = createMockIpcMain();
    registerMemoryHandlers(ipc.ipcMain as never);

    const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.MEMORY, {
      action: 'lightHealth',
      payload: {},
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        totalFiles: 1,
        indexExists: true,
      },
    });
    expect(mocks.getLightMemoryHealth).toHaveBeenCalledTimes(1);
  });

  it('routes lightRebuildIndex through the simple memory channel', async () => {
    const ipc = createMockIpcMain();
    registerMemoryHandlers(ipc.ipcMain as never);

    const response = await ipc.invoke<{ success: boolean; data: unknown }>(IPC_CHANNELS.MEMORY, {
      action: 'lightRebuildIndex',
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        indexPath: '/tmp/memory/INDEX.md',
        indexedFiles: 1,
      },
    });
    expect(mocks.rebuildLightMemoryIndex).toHaveBeenCalledTimes(1);
  });

  it('routes memory pack and v2 bundle dry-run through the domain handler', async () => {
    mocks.database.listMemories.mockReturnValue([]);
    mocks.listMemoryFiles.mockResolvedValue([
      {
        filename: 'project_rules.md',
        name: 'Project Rules',
        description: 'Follow project rules',
        type: 'project',
        content: 'Memory audit should explain why a rule was injected.',
        entryId: 'mem_entry_rules',
        status: 'active',
        source: 'knowledge_inbox',
        schemaVersion: 2,
        updatedAt: '2026-05-13T12:00:00.000Z',
      },
    ]);

    const ipc = createMockIpcMain();
    registerMemoryHandlers(ipc.ipcMain as never);

    const packResponse = await ipc.invoke<IPCResponse>(IPC_DOMAINS.MEMORY, {
      action: 'memoryPack',
      payload: {
        query: 'memory injected',
        projectPath: '/repo/code-agent',
        maxItems: 2,
        totalCharBudget: 200,
      },
    });

    expect(packResponse).toMatchObject({
      success: true,
      data: {
        selectedCount: 1,
        items: [
          expect.objectContaining({
            entryId: 'mem_entry_rules',
            source: expect.objectContaining({ sourceOfTruth: 'light_file' }),
          }),
        ],
      },
    });

    const exportResponse = await ipc.invoke<IPCResponse>(IPC_DOMAINS.MEMORY, {
      action: 'memoryExportV2',
      payload: {},
    });
    expect(exportResponse).toMatchObject({
      success: true,
      data: {
        schemaVersion: 2,
        entries: [expect.objectContaining({ id: 'mem_entry_rules' })],
      },
    });

    const importResponse = await ipc.invoke<IPCResponse>(IPC_DOMAINS.MEMORY, {
      action: 'memoryImportV2DryRun',
      payload: {
        bundle: {
          ...(exportResponse.data as Record<string, unknown>),
          entries: [
            {
              ...((exportResponse.data as { entries: unknown[] }).entries[0] as Record<string, unknown>),
              id: 'mem_entry_new',
              title: 'New Memory',
              content: 'New imported memory',
            },
          ],
        },
      },
    });

    expect(importResponse).toMatchObject({
      success: true,
      data: {
        schemaVersion: 2,
        incomingCount: 1,
        added: 1,
      },
    });

    const applyResponse = await ipc.invoke<IPCResponse>(IPC_DOMAINS.MEMORY, {
      action: 'memoryImportV2Apply',
      payload: {
        bundle: {
          ...(exportResponse.data as Record<string, unknown>),
          entries: [
            {
              ...((exportResponse.data as { entries: unknown[] }).entries[0] as Record<string, unknown>),
              id: 'mem_entry_db_new',
              title: 'New DB Memory',
              content: 'New imported DB memory',
              source: {
                kind: 'db_memory',
                sourceOfTruth: 'db_memory',
                memoryId: null,
                label: 'test bundle',
              },
            },
          ],
        },
      },
    });

    expect(applyResponse).toMatchObject({
      success: true,
      data: {
        incomingCount: 1,
        added: 1,
        applied: 1,
        created: 1,
      },
    });
    expect(mocks.database.createMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: 'New imported DB memory',
      metadata: expect.objectContaining({
        memoryEntry: expect.objectContaining({
          id: 'mem_entry_db_new',
          sourceOfTruth: 'db_memory',
        }),
      }),
    }));
  });

  it('resolves a Knowledge Inbox approval into a seedable project memory and audit tombstone', async () => {
    mocks.database.createMemory
      .mockImplementationOnce((data: Partial<MemoryRecord>) => memory({
        id: 'mem-approved',
        ...data,
        accessCount: 0,
        createdAt: 1778666000000,
        updatedAt: 1778666000000,
      }))
      .mockImplementationOnce((data: Partial<MemoryRecord>) => memory({
        id: 'mem-decision',
        ...data,
        accessCount: 0,
        createdAt: 1778666000001,
        updatedAt: 1778666000001,
      }));

    const ipc = createMockIpcMain();
    registerMemoryHandlers(ipc.ipcMain as never);

    const response = await ipc.invoke<IPCResponse>(IPC_DOMAINS.MEMORY, {
      action: 'memoryInboxResolve',
      payload: {
        candidateId: 'flush:mem-2',
        decision: 'approve',
        content: 'Knowledge Inbox 采纳后进入稳定项目知识',
        title: 'Inbox 采纳闭环',
        source: '压缩前提取 · /repo/code-agent',
        reason: '用户确认后沉淀',
        kind: '候选项目知识',
        projectPath: ' /repo/code-agent ',
        sessionId: ' session-1 ',
      },
    });

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      candidateId: 'flush:mem-2',
      decision: 'approve',
      memory: {
        id: 'mem-approved',
        type: 'project_knowledge',
        category: 'flush_decision',
        source: 'user_defined',
        projectPath: '/repo/code-agent',
        sessionId: 'session-1',
      },
      decisionMemoryId: 'mem-decision',
    });
    expect(mocks.writeLightMemoryFile).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Inbox 采纳闭环',
      description: '用户确认后沉淀',
      type: 'project',
      content: 'Knowledge Inbox 采纳后进入稳定项目知识',
      status: 'active',
      source: 'knowledge_inbox',
      schemaVersion: 2,
    }));
    expect(mocks.rebuildLightMemoryIndex).toHaveBeenCalledTimes(1);
    expect(mocks.database.createMemory).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'project_knowledge',
      category: 'flush_decision',
      content: 'Knowledge Inbox 采纳后进入稳定项目知识',
      summary: 'Inbox 采纳闭环',
      source: 'user_defined',
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
      confidence: 1,
      metadata: {
        knowledgeInbox: expect.objectContaining({
          candidateId: 'flush:mem-2',
          decision: 'approve',
          title: 'Inbox 采纳闭环',
        }),
        memoryEntry: expect.objectContaining({
          schemaVersion: 2,
          status: 'active',
          sourceOfTruth: 'light_file',
          filePath: expect.stringMatching(/^memory-[a-f0-9]+\.md$/),
        }),
      },
    }));
    expect(mocks.database.createMemory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'desktop_activity',
      category: 'knowledge_inbox_decision',
      source: 'user_defined',
      metadata: {
        knowledgeInbox: expect.objectContaining({
          candidateId: 'flush:mem-2',
          decision: 'approve',
          memoryId: 'mem-approved',
        }),
      },
    }));
  });

  it('resolves a Knowledge Inbox rejection without creating seedable memory', async () => {
    mocks.database.createMemory
      .mockImplementationOnce((data: Partial<MemoryRecord>) => memory({
        id: 'mem-rejected-decision',
        ...data,
        accessCount: 0,
        createdAt: 1778666100000,
        updatedAt: 1778666100000,
      }))
      .mockImplementationOnce((data: Partial<MemoryRecord>) => memory({
        id: 'mem-rejected-decision-2',
        ...data,
        accessCount: 0,
        createdAt: 1778666100001,
        updatedAt: 1778666100001,
      }));

    const ipc = createMockIpcMain();
    registerMemoryHandlers(ipc.ipcMain as never);
    const content = '最近会话里的一条旧摘要';

    const response = await ipc.invoke<{ success: boolean; data: { memory: unknown; decisionMemoryId: string } }>(IPC_CHANNELS.MEMORY, {
      action: 'memoryInboxResolve',
      candidateId: 'conversation:0',
      decision: 'reject',
      content,
      title: '最近会话 1',
      kind: '会话结论',
      projectPath: '/repo/code-agent',
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        memory: null,
        decisionMemoryId: 'mem-rejected-decision',
      },
    });
    const secondResponse = await ipc.invoke<{ success: boolean; data: { memory: unknown; decisionMemoryId: string } }>(IPC_CHANNELS.MEMORY, {
      action: 'memoryInboxResolve',
      candidateId: 'conversation:99',
      decision: 'reject',
      content,
      title: '最近会话 1',
      kind: '会话结论',
      projectPath: '/repo/code-agent',
    });

    expect(secondResponse.success).toBe(true);
    expect(mocks.database.createMemory).toHaveBeenCalledTimes(2);
    expect(mocks.database.createMemory).toHaveBeenCalledWith(expect.objectContaining({
      type: 'desktop_activity',
      category: 'knowledge_inbox_decision',
      content: expect.stringContaining('Rejected Knowledge Inbox candidate'),
    }));
    const firstHash = mocks.database.createMemory.mock.calls[0][0].metadata.knowledgeInbox.contentHash;
    const secondHash = mocks.database.createMemory.mock.calls[1][0].metadata.knowledgeInbox.contentHash;
    expect(firstHash).toBe(secondHash);
  });
});
