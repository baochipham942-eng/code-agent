import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryRecord } from '../../../src/main/services/core/repositories';

const dbMocks = vi.hoisted(() => ({
  listMemories: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  getMemory: vi.fn(),
  searchMemories: vi.fn(),
}));

const connectorMocks = vi.hoisted(() => ({
  mailExecute: vi.fn(),
  calendarExecute: vi.fn(),
  remindersExecute: vi.fn(),
}));

const vectorMocks = vi.hoisted(() => ({
  deleteByMetadata: vi.fn(),
  add: vi.fn(),
  save: vi.fn(),
  search: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  register: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/main/services', () => ({
  getDatabase: () => ({
    listMemories: dbMocks.listMemories,
    createMemory: dbMocks.createMemory,
    updateMemory: dbMocks.updateMemory,
    getMemory: dbMocks.getMemory,
    searchMemories: dbMocks.searchMemories,
  }),
}));

vi.mock('../../../src/main/connectors', () => ({
  getConnectorRegistry: () => ({
    get: (id: string) => {
      if (id === 'mail') {
        return { execute: connectorMocks.mailExecute };
      }
      if (id === 'calendar') {
        return { execute: connectorMocks.calendarExecute };
      }
      if (id === 'reminders') {
        return { execute: connectorMocks.remindersExecute };
      }
      return undefined;
    },
  }),
}));

vi.mock('../../../src/main/memory/vectorStore', () => ({
  getVectorStore: () => ({
    deleteByMetadata: vectorMocks.deleteByMetadata,
    add: vectorMocks.add,
    save: vectorMocks.save,
    search: vectorMocks.search,
  }),
}));

vi.mock('../../../src/main/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({
    register: registryMocks.register,
  }),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => loggerMocks,
}));

import { WorkspaceArtifactIndexService } from '../../../src/main/memory/workspaceArtifactIndexService';

function buildMemory(
  overrides: Partial<MemoryRecord> & Pick<MemoryRecord, 'id' | 'category' | 'content' | 'metadata'>,
): MemoryRecord {
  return {
    id: overrides.id,
    type: 'workspace_activity',
    category: overrides.category,
    content: overrides.content,
    summary: overrides.summary || '',
    source: 'session_extracted',
    projectPath: undefined,
    sessionId: undefined,
    confidence: overrides.confidence ?? 0.8,
    metadata: overrides.metadata,
    accessCount: 0,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    lastAccessedAt: undefined,
  };
}

describe('WorkspaceArtifactIndexService', () => {
  beforeEach(() => {
    dbMocks.listMemories.mockReset();
    dbMocks.createMemory.mockReset();
    dbMocks.updateMemory.mockReset();
    dbMocks.getMemory.mockReset();
    dbMocks.searchMemories.mockReset();
    connectorMocks.mailExecute.mockReset();
    connectorMocks.calendarExecute.mockReset();
    connectorMocks.remindersExecute.mockReset();
    vectorMocks.deleteByMetadata.mockReset();
    vectorMocks.add.mockReset();
    vectorMocks.save.mockReset();
    vectorMocks.search.mockReset();
    registryMocks.register.mockReset();

    dbMocks.listMemories.mockReturnValue([]);
    dbMocks.searchMemories.mockReturnValue([]);
    vectorMocks.deleteByMetadata.mockReturnValue(0);
    vectorMocks.add.mockResolvedValue('doc-1');
    vectorMocks.save.mockResolvedValue(undefined);
    vectorMocks.search.mockReturnValue([]);
  });

  it('persists recent office artifacts into memories and vector index', async () => {
    connectorMocks.mailExecute.mockImplementation(async (action: string) => {
      if (action === 'list_mailboxes') {
        return { data: [{ account: 'Work', name: 'Inbox' }] };
      }
      if (action === 'list_messages') {
        return {
          data: [{
            id: 101,
            account: 'Work',
            mailbox: 'Inbox',
            subject: 'Issue #42 follow-up',
            sender: 'alice@example.com',
            receivedAtMs: Date.parse('2026-03-14T10:00:00+08:00'),
            read: false,
          }],
        };
      }
      if (action === 'read_message') {
        return {
          data: {
            id: 101,
            account: 'Work',
            mailbox: 'Inbox',
            subject: 'Re: Issue #42 follow-up',
            sender: 'alice@example.com',
            receivedAtMs: Date.parse('2026-03-14T10:00:00+08:00'),
            read: false,
            content: '请先补完 issue #42 的最终方案，然后同步 memory plan 的剩余条目。',
            attachmentCount: 2,
            attachments: ['proposal-v3.pdf', 'notes.txt'],
          },
        };
      }
      throw new Error(`unexpected mail action: ${action}`);
    });
    connectorMocks.calendarExecute.mockResolvedValue({
      data: [{
        uid: 'cal-1',
        calendar: 'Work',
        title: 'Issue #42 review',
        startAtMs: Date.parse('2026-03-14T15:00:00+08:00'),
        endAtMs: Date.parse('2026-03-14T15:30:00+08:00'),
        location: 'Meeting Room A',
        notes: '需要 review 最终方案，并确认 memory plan 与 follow-up owner。',
        url: 'https://calendar.local/event/cal-1',
      }],
    });
    connectorMocks.remindersExecute.mockResolvedValue({
      data: [{
        id: 'rem-1',
        list: 'Work',
        title: 'Issue #42 follow-up draft',
        completed: false,
        notes: '需要整理 follow-up draft，并确认 blockers。',
        remindAtMs: Date.parse('2026-03-14T18:00:00+08:00'),
      }],
    });
    dbMocks.createMemory.mockImplementation((data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>) => buildMemory({
      id: `mem-${data.category}`,
      category: data.category,
      content: data.content,
      summary: data.summary,
      confidence: data.confidence,
      metadata: data.metadata,
    }));

    const service = new WorkspaceArtifactIndexService({
      refreshIntervalMs: 60_000,
      mailLookbackHours: 72,
      maxMailboxes: 4,
      maxMessagesPerMailbox: 4,
      calendarLookbackHours: 24,
      calendarAheadHours: 72,
      maxCalendarEvents: 20,
      maxReminders: 20,
    });

    const result = await service.refreshRecentArtifacts();

    expect(result.indexedArtifacts).toBe(3);
    expect(result.createdArtifacts).toBe(3);
    expect(result.updatedArtifacts).toBe(0);
    expect(result.bySource).toEqual({
      mail: 1,
      calendar: 1,
      reminders: 1,
    });
    expect(dbMocks.createMemory).toHaveBeenCalledTimes(3);
    expect(dbMocks.createMemory).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'workspace_activity',
      category: 'mail_message',
      content: expect.stringMatching(/附件：2 个 \(proposal-v3\.pdf, notes\.txt\)[\s\S]*正文摘要：请先补完 issue #42 的最终方案/),
      metadata: expect.objectContaining({
        contentLevel: true,
        bodyPreview: expect.stringContaining('issue #42'),
        attachmentCount: 2,
        attachmentNames: ['proposal-v3.pdf', 'notes.txt'],
        threadKey: 'issue #42 follow-up',
        threadSubject: 'Issue #42 follow-up',
      }),
    }));
    expect(dbMocks.createMemory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'workspace_activity',
      category: 'calendar_event',
      content: expect.stringContaining('描述摘要：需要 review 最终方案'),
      metadata: expect.objectContaining({
        contentLevel: true,
        notesPreview: expect.stringContaining('memory plan'),
        url: 'https://calendar.local/event/cal-1',
      }),
    }));
    expect(dbMocks.createMemory).toHaveBeenNthCalledWith(3, expect.objectContaining({
      type: 'workspace_activity',
      category: 'reminder_item',
      content: expect.stringContaining('备注摘要：需要整理 follow-up draft'),
      metadata: expect.objectContaining({
        contentLevel: true,
        notesPreview: expect.stringContaining('follow-up draft'),
      }),
    }));
    expect(vectorMocks.add).toHaveBeenCalledTimes(3);
    expect(vectorMocks.save).toHaveBeenCalledTimes(1);
  });

  it('searches indexed artifacts from semantic hits and applies source filters', () => {
    const indexedMailMemory = buildMemory({
      id: 'mem-mail-1',
      category: 'mail_message',
      content: '邮件主题：Issue #42 follow-up\n发件人：alice@example.com',
      summary: 'Issue #42 follow-up | alice@example.com',
      metadata: {
        kind: 'workspace_artifact',
        sourceKind: 'mail',
        artifactKey: 'mail:Work:Inbox:101',
        title: 'Issue #42 follow-up',
        subtitle: 'alice@example.com | Work / Inbox',
        timestampMs: Date.parse('2026-03-14T10:00:00+08:00'),
        account: 'Work',
        mailbox: 'Inbox',
        indexedAtMs: Date.now(),
      },
    });

    vectorMocks.search.mockReturnValue([
      {
        document: {
          id: 'doc-1',
          content: 'Mail subject: Issue #42 follow-up',
          embedding: [],
          metadata: {
            source: 'knowledge',
            category: 'workspace_artifact',
            memoryId: 'mem-mail-1',
            createdAt: Date.now(),
          },
        },
        score: 0.86,
        distance: 0.14,
      },
    ]);
    dbMocks.getMemory.mockReturnValue(indexedMailMemory);

    const service = new WorkspaceArtifactIndexService();
    const result = service.searchArtifacts('issue #42', {
      sources: ['mail'],
      account: 'Work',
      mailboxes: ['Inbox'],
      limit: 5,
    });

    expect(vectorMocks.search).toHaveBeenCalledWith('issue #42', expect.objectContaining({
      topK: 30,
      filter: expect.objectContaining({
        category: 'workspace_artifact',
      }),
    }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'mem-mail-1',
      sourceKind: 'mail',
      title: 'Issue #42 follow-up',
      score: 0.86,
    });
    expect(result.countsBySource).toEqual({
      mail: 1,
      calendar: 0,
      reminders: 0,
    });
  });
});
