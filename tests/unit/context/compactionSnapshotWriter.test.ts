import { beforeEach, describe, expect, it, vi } from 'vitest';

const snapshotWriterMocks = vi.hoisted(() => ({
  db: {
    isReady: true,
    insertCompactionSnapshot: vi.fn(),
  },
  logger: {
    warn: vi.fn(),
  },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => snapshotWriterMocks.db,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => snapshotWriterMocks.logger,
}));

import { writeCompactionSnapshot } from '../../../src/host/context/compactionSnapshotWriter';

describe('compactionSnapshotWriter', () => {
  beforeEach(() => {
    delete process.env.CODE_AGENT_CLI_MODE;
    delete process.env.CODE_AGENT_WEB_MODE;
    snapshotWriterMocks.db.isReady = true;
    snapshotWriterMocks.db.insertCompactionSnapshot.mockReset();
    snapshotWriterMocks.db.insertCompactionSnapshot.mockReturnValue({
      id: 'compact_1',
      createdAt: 123,
      byteSize: 10,
    });
    snapshotWriterMocks.logger.warn.mockReset();
  });

  it('uses the main database sink in web mode even when CLI mode is enabled', () => {
    process.env.CODE_AGENT_CLI_MODE = 'true';
    process.env.CODE_AGENT_WEB_MODE = 'true';

    writeCompactionSnapshot({
      sessionId: 'session-1',
      strategy: 'ai_summary',
      preMessages: [{ role: 'user', content: 'before' }],
      postMessages: [{ role: 'system', content: 'after' }],
      preTokens: 100,
      postTokens: 40,
      savedTokens: 60,
      usagePercent: 80,
    });

    expect(snapshotWriterMocks.db.insertCompactionSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        strategy: 'ai_summary',
        preMessageCount: 1,
        postMessageCount: 1,
        usagePercent: 80,
      }),
    );
  });

  it('records prefix shape hashes before/after compaction (WP2-2b)', () => {
    writeCompactionSnapshot({
      sessionId: 'session-1',
      strategy: 'ai_summary',
      preMessages: [
        { role: 'user', content: 'before-1' },
        { role: 'assistant', content: 'before-2' },
      ],
      postMessages: [{ role: 'system', content: 'after' }],
      preTokens: 100,
      postTokens: 40,
      savedTokens: 60,
      usagePercent: 80,
      systemPrompt: 'sys',
    });

    const call = snapshotWriterMocks.db.insertCompactionSnapshot.mock.calls[0][0] as {
      shapeHashBefore?: string;
      shapeHashAfter?: string;
    };
    expect(call.shapeHashBefore).toMatch(/^[0-9a-f]{16}$/);
    expect(call.shapeHashAfter).toMatch(/^[0-9a-f]{16}$/);
    // 压缩改变了请求前缀 shape → 前后 hash 必不同
    expect(call.shapeHashBefore).not.toBe(call.shapeHashAfter);
  });
});
