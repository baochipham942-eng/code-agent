import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { repairProjectionOrderMismatches } from '../../scripts/repair/n-readflip-projection-order';
import { applySchema } from '../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../src/host/services/core/database/migrations';
import { applyConversationBranchSchema } from '../../src/host/services/core/database/schemaConversationBranch';
import { ConversationBranchRepository } from '../../src/host/services/core/repositories/ConversationBranchRepository';
import { SessionRepository } from '../../src/host/services/core/repositories/SessionRepository';
import { createLogger } from '../../src/host/services/infra/logger';

const logger = createLogger('nReadflipProjectionOrderRepair.test');
vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
vi.spyOn(logger, 'info').mockImplementation(() => undefined);
vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
vi.spyOn(logger, 'error').mockImplementation(() => undefined);

describe('N-READFLIP one-time projection order repair', () => {
  let db: InstanceType<typeof Database>;
  let sessions: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    sessions = new SessionRepository(db);
  });

  afterEach(() => db.close());

  function createSession(sessionId: string, backfillTimestamp?: number): void {
    sessions.createSession({
      id: sessionId,
      userId: 'owner-1',
      projectId: 'project-1',
      title: sessionId,
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
    } as never);
    sessions.addMessage(sessionId, { id: `${sessionId}-u1`, role: 'user', content: 'one', timestamp: 10 });
    sessions.addMessage(sessionId, { id: `${sessionId}-a1`, role: 'assistant', content: 'answer', timestamp: 20 });
    if (backfillTimestamp !== undefined) {
      sessions.addMessage(sessionId, {
        id: `${sessionId}-telemetry`,
        role: 'user',
        content: 'recovered prompt',
        timestamp: backfillTimestamp,
      });
    }
  }

  it('uses ledger payloads in a projection_replace event and leaves non-target sessions unchanged', () => {
    createSession('target', 5);
    createSession('healthy');

    const report = repairProjectionOrderMismatches(db, {
      apply: true,
      targetSessionIds: ['target'],
    });

    expect(report).toMatchObject({
      sessionCount: 2,
      targetCount: 1,
      repairedCount: 1,
      changedSessionCount: 1,
      unchangedNonTargetSessionCount: 1,
      unexpectedChangedSessions: [],
    });
    expect(report.targets[0]).toMatchObject({
      sessionId: 'target',
      changed: true,
      beforeIssueCount: 3,
      replacementEventId: expect.any(String),
      replacementMessageCount: 3,
    });
    expect(db.prepare(`
      SELECT event_type FROM conversation_branch_events WHERE id = ?
    `).get(report.targets[0].replacementEventId)).toEqual({ event_type: 'projection_replace' });
    const ledger = new ConversationBranchRepository(db);
    expect(ledger.replay('target', { ownerUserId: 'owner-1', projectId: 'project-1' })
      .messages.map((entry) => entry.projectedMessageId)).toEqual([
      'target-telemetry',
      'target-u1',
      'target-a1',
    ]);

    expect(repairProjectionOrderMismatches(db, {
      apply: true,
      targetSessionIds: ['target'],
    })).toMatchObject({ repairedCount: 0, changedSessionCount: 0, alreadyHealthyCount: 1 });
  });

  it('fails closed before writes when a non-target session is unhealthy', () => {
    createSession('target', 5);
    createSession('unexpected', 4);
    const eventsBefore = db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_branch_events
    `).get();

    expect(() => repairProjectionOrderMismatches(db, {
      apply: true,
      targetSessionIds: ['target'],
    })).toThrow('Unexpected unhealthy non-target unexpected');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM conversation_branch_events`).get())
      .toEqual(eventsBefore);
  });
});
