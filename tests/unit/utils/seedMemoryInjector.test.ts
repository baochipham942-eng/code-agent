import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryRecord } from '../../../src/main/services/core/repositories';
import { hashInboxContent } from '../../../src/main/memory/knowledgeInboxDecision';

const mocks = vi.hoisted(() => ({
  db: {
    isReady: true,
    listMemories: vi.fn(),
  },
  getDatabase: vi.fn(),
  packMemoryEntries: vi.fn(),
}));

vi.mock('../../../src/main/services', () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../../../src/main/memory/memoryEntryRuntime', () => ({
  packMemoryEntries: mocks.packMemoryEntries,
}));

import { buildPackedSeedMemoryBlock, buildSeedMemoryBlock } from '../../../src/main/utils/seedMemoryInjector';

function memory(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'mem-default',
    type: 'project_knowledge',
    category: 'flush_decision',
    content: 'Default memory',
    summary: 'Default memory',
    source: 'session_extracted',
    projectPath: '/repo/code-agent',
    sessionId: 'session-1',
    confidence: 0.9,
    metadata: {},
    accessCount: 0,
    createdAt: 1778664000000,
    updatedAt: 1778664000000,
    ...overrides,
  };
}

describe('seedMemoryInjector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue(mocks.db);
    mocks.packMemoryEntries.mockResolvedValue({
      items: [],
      block: '',
      totalChars: 0,
    });
  });

  it('suppresses source memories that already have Knowledge Inbox decisions', () => {
    const ignored = memory({
      id: 'mem-ignored',
      content: 'Ignore this extracted memory',
      summary: 'Ignored memory',
      confidence: 1,
    });
    const approved = memory({
      id: 'mem-approved',
      content: 'Keep the edited approved memory',
      summary: 'Approved memory',
      source: 'user_defined',
      confidence: 1,
      metadata: {
        knowledgeInbox: {
          candidateId: 'flush:mem-ignored',
          decision: 'approve',
          contentHash: hashInboxContent('Keep the edited approved memory'),
        },
      },
    });
    const regular = memory({
      id: 'mem-regular',
      content: 'Keep this regular project memory',
      summary: 'Regular memory',
      confidence: 0.8,
    });
    const decision = memory({
      id: 'mem-decision',
      type: 'desktop_activity',
      category: 'knowledge_inbox_decision',
      content: 'Rejected Knowledge Inbox candidate: Ignored memory',
      summary: 'Ignore decision',
      source: 'user_defined',
      metadata: {
        knowledgeInbox: {
          candidateId: 'flush:mem-ignored',
          decision: 'reject',
          contentHash: hashInboxContent('Ignore this extracted memory'),
          title: 'Ignored memory',
          memoryId: null,
        },
      },
    });

    mocks.db.listMemories
      .mockReturnValueOnce([decision])
      .mockReturnValueOnce([ignored, approved, regular]);

    const block = buildSeedMemoryBlock('/repo/code-agent');

    expect(block).toContain('Approved memory');
    expect(block).toContain('Regular memory');
    expect(block).not.toContain('Ignored memory');
    expect(mocks.db.listMemories).toHaveBeenNthCalledWith(1, {
      category: 'knowledge_inbox_decision',
      projectPath: '/repo/code-agent',
      limit: 100,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });
  });

  it('builds packed seed memory from the unified packer when available', async () => {
    mocks.packMemoryEntries.mockResolvedValueOnce({
      items: [{ entryId: 'mem_entry_1' }],
      block: '<memory-pack>\n- [1] Project Rule\n  content: Keep memory injection visible\n</memory-pack>',
      totalChars: 88,
    });

    const block = await buildPackedSeedMemoryBlock({
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
      query: 'memory injection',
    });

    expect(block).toContain('## Packed Memories');
    expect(block).toContain('<memory-pack>');
    expect(mocks.packMemoryEntries).toHaveBeenCalledWith(expect.objectContaining({
      query: 'memory injection',
      projectPath: '/repo/code-agent',
      sessionId: 'session-1',
      statuses: ['active'],
    }), mocks.db);
  });
});
