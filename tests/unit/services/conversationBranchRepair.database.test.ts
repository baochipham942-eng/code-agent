import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

vi.mock('../../../src/host/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => class MockDatabase {},
}));

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { ConversationBranchRepository } from '../../../src/host/services/core/repositories/ConversationBranchRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const boundary = { ownerUserId: 'owner-1', projectId: 'project-1' } as const;

describe('DatabaseService conversation projection repair facade', () => {
  let db: InstanceType<typeof Database>;

  afterEach(() => db?.close());

  it('delegates the public repair to reconstruction while retaining override as a separate low-level method', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    const ledger = new ConversationBranchRepository(db);
    const sessions = new SessionRepository(db);
    sessions.createSession({
      id: 'source',
      userId: 'owner-1',
      projectId: 'project-1',
      title: 'Source',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
    } as never);
    sessions.addMessage('source', {
      id: 'u1',
      role: 'user',
      content: 'original',
      timestamp: 10,
    });
    db.prepare(`UPDATE messages SET content = 'tampered' WHERE id = 'u1'`).run();
    const quarantine = ledger.auditAndQuarantine({
      sessionId: 'source',
      boundary,
      idempotencyKey: 'quarantine-database-facade',
    });

    const service = new DatabaseService();
    Object.assign(service as unknown as Record<string, unknown>, {
      db,
      conversationBranchRepo: ledger,
    });
    const repaired = service.repairConversationLineage({
      sessionId: 'source',
      boundary,
      issueDigest: quarantine.issueDigest,
      reason: 'rebuild compatibility rows from the immutable replay ledger',
      idempotencyKey: 'repair-database-facade',
    });

    expect(repaired.status).toBe('healthy');
    expect(db.prepare(`SELECT content FROM messages WHERE id = 'u1'`).get())
      .toEqual({ content: 'original' });
    expect(typeof service.recordConversationLineageRepairOverride).toBe('function');
  });
});
