import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { ConversationBranchRepository } from '../../../src/host/services/core/repositories/ConversationBranchRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { createLogger } from '../../../src/host/services/infra/logger';

const logger = createLogger('ConversationBranchLoadingReplay.test');
vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
vi.spyOn(logger, 'info').mockImplementation(() => undefined);
vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
vi.spyOn(logger, 'error').mockImplementation(() => undefined);

const boundary = { ownerUserId: 'owner-1', projectId: 'project-1' } as const;

describe('loading-grade conversation replay', () => {
  let db: InstanceType<typeof Database>;
  let sessions: SessionRepository;
  let ledger: ConversationBranchRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    sessions = new SessionRepository(db);
    ledger = new ConversationBranchRepository(db);
    sessions.createSession({
      id: 'source',
      userId: boundary.ownerUserId,
      projectId: boundary.projectId,
      title: 'Source',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
    } as never);
    for (const [id, role, content, timestamp] of [
      ['u1', 'user', 'one', 10],
      ['a1', 'assistant', 'answer one', 20],
      ['u2', 'user', 'two', 30],
      ['a2', 'assistant', 'answer two', 40],
    ] as const) {
      sessions.addMessage('source', { id, role, content, timestamp });
    }
  });

  afterEach(() => db.close());

  function snapshot() {
    return db.prepare(`
      SELECT * FROM conversation_branch_replay_snapshots
      WHERE branch_id = (SELECT id FROM conversation_branches WHERE session_id = 'source')
    `).get() as Record<string, unknown>;
  }

  it('stores all six ADR anchors and loads from ledger when the messages cache is absent', () => {
    const first = ledger.replayForLoad('source', boundary);
    expect(first.messages.map((message) => message.projectedMessageId)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(snapshot()).toMatchObject({
      through_event_sequence: 4,
      through_event_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      through_ordinal: 3,
      replay_payload_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      schema_version: 1,
    });

    db.prepare("DELETE FROM messages WHERE session_id = 'source'").run();
    expect(ledger.replayForLoad('source', boundary).messages.map((message) => message.message.content))
      .toEqual(['one', 'answer one', 'two', 'answer two']);
  });

  it('falls back to audit replay when the snapshot payload digest is invalid', () => {
    ledger.replayForLoad('source', boundary);
    db.prepare(`
      UPDATE conversation_branch_replay_snapshots
      SET replay_payload_json = '{"references":[],"state":{"activeOrdinals":[],"openRewinds":[]}}'
    `).run();

    expect(ledger.replayForLoad('source', boundary).messages).toHaveLength(4);
    const repaired = snapshot();
    expect(repaired.replay_payload_digest).not.toBe('');
    expect(String(repaired.replay_payload_json)).toContain('answer two');
  });

  it('queries the event anchor even with an empty suffix', () => {
    ledger.replayForLoad('source', boundary);
    db.prepare(`
      UPDATE conversation_branch_replay_snapshots
      SET through_event_sequence = 999
    `).run();

    ledger.replayForLoad('source', boundary);
    expect(snapshot().through_event_sequence).toBe(4);
  });

  it('queries the reference anchor even with an empty suffix', () => {
    ledger.replayForLoad('source', boundary);
    db.prepare(`
      UPDATE conversation_branch_replay_snapshots
      SET through_ordinal = 999
    `).run();

    ledger.replayForLoad('source', boundary);
    expect(snapshot().through_ordinal).toBe(3);
  });

  it('rejects a suffix whose first event does not connect to the snapshot digest', () => {
    ledger.replayForLoad('source', boundary);
    sessions.addMessage('source', {
      id: 'u3',
      role: 'user',
      content: 'three',
      timestamp: 50,
    });
    db.exec('DROP TRIGGER conversation_branch_events_immutable_update');
    db.prepare(`
      UPDATE conversation_branch_events
      SET previous_event_digest = ?
      WHERE branch_id = (SELECT id FROM conversation_branches WHERE session_id = 'source')
        AND sequence = 5
    `).run('0'.repeat(64));

    expect(() => ledger.replayForLoad('source', boundary)).toThrow('BRANCH_QUARANTINED');
  });

  it('applies rewind and restore suffixes without rebuilding from messages', () => {
    const rewind = sessions.applyPromptRewind('source', 'u2', {
      ownerUserId: boundary.ownerUserId,
      idempotencyKey: 'rewind-u2',
      createdAt: 50,
    });
    expect(ledger.replayForLoad('source', boundary).messages.map((message) => message.projectedMessageId))
      .toEqual(['u1', 'a1', 'u2']);

    sessions.restorePromptRewind('source', rewind.rewindId, 60, boundary.ownerUserId);
    db.prepare("DELETE FROM messages WHERE session_id = 'source'").run();
    expect(ledger.replayForLoad('source', boundary).messages.map((message) => message.projectedMessageId))
      .toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('records clearAllMessages as an authoritative empty projection replacement', () => {
    expect(sessions.clearAllMessages()).toBe(4);
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(ledger.replay('source', boundary).messages).toEqual([]);
    expect(ledger.auditLineage('source', boundary).status).toBe('healthy');
    expect(db.prepare(`
      SELECT event_type
      FROM conversation_branch_events
      WHERE branch_id = (SELECT id FROM conversation_branches WHERE session_id = 'source')
      ORDER BY sequence DESC
      LIMIT 1
    `).get()).toEqual({ event_type: 'projection_replace' });
  });

  it('reconciles a backdated telemetry append to projection chronology through the ledger', () => {
    sessions.addMessage('source', {
      id: 'telemetry-user-late-recovery',
      role: 'user',
      content: 'recovered earlier prompt',
      timestamp: 5,
    });
    sessions.reconcileMessageProjectionOrder(
      'source',
      'test telemetry chronological reconciliation',
      50,
    );

    expect(ledger.auditLineage('source', boundary).status).toBe('healthy');
    expect(ledger.replayForLoad('source', boundary).messages.map((message) => message.projectedMessageId))
      .toEqual(['telemetry-user-late-recovery', 'u1', 'a1', 'u2', 'a2']);
  });
});
