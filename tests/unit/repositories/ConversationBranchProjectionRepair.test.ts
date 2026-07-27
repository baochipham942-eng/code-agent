import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { ConversationBranchRepository } from '../../../src/host/services/core/repositories/ConversationBranchRepository';
import { SessionForkRepository } from '../../../src/host/services/core/repositories/SessionForkRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { createLogger } from '../../../src/host/services/infra/logger';

const logger = createLogger('ConversationBranchProjectionRepair.test');
vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
vi.spyOn(logger, 'info').mockImplementation(() => undefined);
vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
vi.spyOn(logger, 'error').mockImplementation(() => undefined);
const boundary = { ownerUserId: 'owner-1', projectId: 'project-1' } as const;
const reason = 'restore the compatibility projection from independently audited immutable replay';

type RepairFaultPhase = 'after_projection_write' | 'after_event_append';

describe('ConversationBranchRepository compatibility projection repair', () => {
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
      userId: 'owner-1',
      projectId: 'project-1',
      title: 'Source',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
    } as never);
    sessions.addMessage('source', { id: 'u1', role: 'user', content: 'one', timestamp: 10 });
    sessions.addMessage('source', { id: 'a1', role: 'assistant', content: 'answer', timestamp: 10 });
    sessions.addMessage('source', { id: 'u2', role: 'user', content: 'two', timestamp: 20 });
    expect(ledger.auditLineage('source', boundary).status).toBe('healthy');
  });

  afterEach(() => db.close());

  const corruptions = [
    {
      name: 'missing',
      expectedCode: 'PROJECTION_ALIAS_MISSING',
      apply: (database: InstanceType<typeof Database>) => {
        database.prepare(`DELETE FROM messages WHERE session_id = 'source' AND id = 'u1'`).run();
      },
    },
    {
      name: 'payload',
      expectedCode: 'PROJECTION_ALIAS_PAYLOAD_MISMATCH',
      apply: (database: InstanceType<typeof Database>) => {
        database.prepare(`
          UPDATE messages SET content = 'tampered payload'
          WHERE session_id = 'source' AND id = 'a1'
        `).run();
      },
    },
    {
      name: 'extra',
      expectedCode: 'PROJECTION_ALIAS_EXTRA',
      apply: (database: InstanceType<typeof Database>) => {
        database.prepare(`
          INSERT INTO messages (id, session_id, role, content, timestamp, visibility)
          VALUES ('rogue', 'source', 'assistant', 'untracked', 30, 'active')
        `).run();
      },
    },
    {
      name: 'same timestamp order',
      expectedCode: 'PROJECTION_ALIAS_ORDER_MISMATCH',
      apply: (database: InstanceType<typeof Database>) => {
        database.prepare(`
          UPDATE messages SET rowid = 100
          WHERE session_id = 'source' AND id = 'u1'
        `).run();
      },
    },
  ] as const;

  it.each(corruptions)(
    'repairs $name from immutable replay without deleting compatibility rows',
    ({ expectedCode, apply }) => {
      apply(db);
      const beforeQuarantine = ledger.auditLineage('source', boundary);
      expect(beforeQuarantine.issues.map((issue) => issue.code)).toContain(expectedCode);

      expect(() => ledger.repairCompatibilityProjection({
        sessionId: 'source',
        boundary,
        issueDigest: beforeQuarantine.issueDigest,
        reason,
        idempotencyKey: `repair-without-quarantine-${expectedCode}`,
        createdAt: 90,
      })).toThrow('PROJECTION_REPAIR_REJECTED');

      const quarantine = ledger.auditAndQuarantine({
        sessionId: 'source',
        boundary,
        idempotencyKey: `quarantine-${expectedCode}`,
        createdAt: 100,
      });
      const repaired = ledger.repairCompatibilityProjection({
        sessionId: 'source',
        boundary,
        issueDigest: quarantine.issueDigest,
        reason,
        idempotencyKey: `repair-${expectedCode}`,
        createdAt: 110,
      });

      expect(repaired).toMatchObject({ status: 'healthy', issues: [] });
      expect(db.prepare(`
        SELECT id
        FROM messages
        WHERE session_id = 'source' AND visibility = 'active'
        ORDER BY timestamp ASC, rowid ASC
      `).all()).toEqual([{ id: 'u1' }, { id: 'a1' }, { id: 'u2' }]);
      expect(db.prepare(`
        SELECT id, content
        FROM messages
        WHERE session_id = 'source' AND id IN ('u1', 'a1', 'u2')
        ORDER BY timestamp ASC, rowid ASC
      `).all()).toEqual([
        { id: 'u1', content: 'one' },
        { id: 'a1', content: 'answer' },
        { id: 'u2', content: 'two' },
      ]);

      if (expectedCode === 'PROJECTION_ALIAS_EXTRA') {
        expect(db.prepare(`
          SELECT id, visibility, hidden_by_rewind_id
          FROM messages
          WHERE id = 'rogue'
        `).get()).toMatchObject({
          id: 'rogue',
          visibility: 'rewound',
          hidden_by_rewind_id: expect.stringContaining('projection_repair:'),
        });
      }

      const event = db.prepare(`
        SELECT event_type, payload_json
        FROM conversation_branch_events
        WHERE idempotency_key = ?
      `).get(`repair-${expectedCode}`) as { event_type: string; payload_json: string };
      expect(event.event_type).toBe('projection_repair');
      const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
      expect(payload).toMatchObject({
        issueDigest: quarantine.issueDigest,
        quarantineEventId: quarantine.quarantineEventId,
        previousProjectionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        repairedProjectionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        expectedActiveCount: 3,
      });
      expect(event.payload_json).not.toContain('tampered payload');
      expect(event.payload_json).not.toContain('untracked');
      expect(event.payload_json).not.toContain('"content"');

      const eventCountBeforeRetry = db.prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_branch_events
        WHERE event_type = 'projection_repair'
      `).get() as { count: number };
      expect(ledger.repairCompatibilityProjection({
        sessionId: 'source',
        boundary,
        issueDigest: quarantine.issueDigest,
        reason,
        idempotencyKey: `repair-${expectedCode}`,
        createdAt: 120,
      }).status).toBe('healthy');
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_branch_events
        WHERE event_type = 'projection_repair'
      `).get()).toEqual(eventCountBeforeRetry);
      expect(() => ledger.repairCompatibilityProjection({
        sessionId: 'source',
        boundary,
        issueDigest: quarantine.issueDigest,
        reason: `${reason} with conflicting operator evidence`,
        idempotencyKey: `repair-${expectedCode}`,
      })).toThrow('IDEMPOTENCY_CONFLICT');
    },
  );

  it.each<RepairFaultPhase>(['after_projection_write', 'after_event_append'])(
    'rolls back projection and ledger writes when fault injection fails at %s',
    (faultPhase) => {
      db.prepare(`
        UPDATE messages SET content = 'tampered payload'
        WHERE session_id = 'source' AND id = 'a1'
      `).run();
      const quarantine = ledger.auditAndQuarantine({
        sessionId: 'source',
        boundary,
        idempotencyKey: `quarantine-fault-${faultPhase}`,
      });
      const faulting = new ConversationBranchRepository(db, {
        projectionRepairFaultInjector: (phase) => {
          if (phase === faultPhase) throw new Error(`injected ${phase}`);
        },
      });

      expect(() => faulting.repairCompatibilityProjection({
        sessionId: 'source',
        boundary,
        issueDigest: quarantine.issueDigest,
        reason,
        idempotencyKey: `repair-fault-${faultPhase}`,
      })).toThrow(`injected ${faultPhase}`);
      expect(db.prepare(`SELECT content FROM messages WHERE id = 'a1'`).get())
        .toEqual({ content: 'tampered payload' });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM conversation_branch_events
        WHERE idempotency_key = ?
      `).get(`repair-fault-${faultPhase}`)).toEqual({ count: 0 });
      expect(ledger.auditLineage('source', boundary).status).toBe('quarantined');
    },
  );

  it('rejects stale digest, weak reason and non-projection lineage corruption with zero repair writes', () => {
    db.prepare(`
      UPDATE messages SET content = 'tampered payload'
      WHERE session_id = 'source' AND id = 'a1'
    `).run();
    const quarantine = ledger.auditAndQuarantine({
      sessionId: 'source',
      boundary,
      idempotencyKey: 'quarantine-validation',
    });
    const repairCount = (): number => Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM conversation_branch_events
      WHERE event_type = 'projection_repair'
    `).get() as { count: number }).count);

    expect(() => ledger.repairCompatibilityProjection({
      sessionId: 'source',
      boundary,
      issueDigest: '0'.repeat(64),
      reason,
      idempotencyKey: 'repair-stale',
    })).toThrow('PROJECTION_REPAIR_REJECTED');
    expect(() => ledger.repairCompatibilityProjection({
      sessionId: 'source',
      boundary,
      issueDigest: quarantine.issueDigest,
      reason: 'too short',
      idempotencyKey: 'repair-weak-reason',
    })).toThrow('PROJECTION_REPAIR_REJECTED');
    expect(repairCount()).toBe(0);

    db.exec('DROP TRIGGER conversation_branches_immutable_update');
    db.prepare(`
      UPDATE conversation_branches
      SET lineage_digest = ?
      WHERE session_id = 'source'
    `).run('f'.repeat(64));
    const structural = ledger.auditAndQuarantine({
      sessionId: 'source',
      boundary,
      idempotencyKey: 'quarantine-structural',
    });
    const projectionBefore = db.prepare(`
      SELECT rowid AS __rowid, *
      FROM messages
      WHERE session_id = 'source'
      ORDER BY timestamp, rowid
    `).all();
    expect(() => ledger.repairCompatibilityProjection({
      sessionId: 'source',
      boundary,
      issueDigest: structural.issueDigest,
      reason,
      idempotencyKey: 'repair-structural',
    })).toThrow('PROJECTION_REPAIR_REJECTED');
    expect(db.prepare(`
      SELECT rowid AS __rowid, *
      FROM messages
      WHERE session_id = 'source'
      ORDER BY timestamp, rowid
    `).all()).toEqual(projectionBefore);
    expect(repairCount()).toBe(0);
  });

  it('refuses to treat a hash-chain finding as projection repairable', () => {
    db.prepare(`
      UPDATE messages SET content = 'tampered payload'
      WHERE session_id = 'source' AND id = 'a1'
    `).run();
    db.exec('DROP TRIGGER conversation_branch_events_immutable_update');
    db.prepare(`
      UPDATE conversation_branch_events
      SET payload_digest = ?
      WHERE branch_id = (
        SELECT id FROM conversation_branches WHERE session_id = 'source'
      ) AND sequence = 1
    `).run('0'.repeat(64));
    const quarantine = ledger.auditAndQuarantine({
      sessionId: 'source',
      boundary,
      idempotencyKey: 'quarantine-hash-chain',
    });
    expect(quarantine.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'EVENT_PAYLOAD_DIGEST_MISMATCH',
      'EVENT_DIGEST_MISMATCH',
      'PROJECTION_ALIAS_PAYLOAD_MISMATCH',
    ]));

    expect(() => ledger.repairCompatibilityProjection({
      sessionId: 'source',
      boundary,
      issueDigest: quarantine.issueDigest,
      reason,
      idempotencyKey: 'repair-hash-chain',
    })).toThrow('PROJECTION_REPAIR_REJECTED');
    expect(db.prepare(`SELECT content FROM messages WHERE id = 'a1'`).get())
      .toEqual({ content: 'tampered payload' });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM conversation_branch_events
      WHERE idempotency_key = 'repair-hash-chain'
    `).get()).toEqual({ count: 0 });
  });

  it('recalibrates source order evidence when same-timestamp repair changes rowids', () => {
    const forks = new SessionForkRepository(db, ledger);
    const fork = forks.createFork({
      sourceSessionId: 'source',
      anchorAssistantMessageId: 'a1',
      idempotencyKey: 'fork-before-repair',
      ownerUserId: 'owner-1',
      forkId: 'fork-before-repair',
      childSessionId: 'child',
      childTitle: 'Child',
      workspaceMode: 'shared_current',
      contextDeliveryMode: 'neo_native_prefix',
      now: 50,
    });
    expect(forks.getContextSource('child')).not.toBeNull();
    db.prepare(`
      UPDATE messages SET rowid = 100
      WHERE session_id = 'source' AND id = 'u1'
    `).run();
    const quarantine = ledger.auditAndQuarantine({
      sessionId: 'source',
      boundary,
      idempotencyKey: 'quarantine-source-order',
    });

    ledger.repairCompatibilityProjection({
      sessionId: 'source',
      boundary,
      issueDigest: quarantine.issueDigest,
      reason,
      idempotencyKey: 'repair-source-order',
    });

    expect(forks.getContextSource('child')).toMatchObject({
      lineage: { forkId: fork.forkId },
      mappedActivePrefix: [
        { sourceMessageId: 'u1' },
        { sourceMessageId: 'a1' },
      ],
    });
    const mappedRows = db.prepare(`
      SELECT map.source_message_id, map.source_order_key, map.source_row_digest,
             source.timestamp, source.rowid AS source_rowid
      FROM session_fork_message_map AS map
      JOIN messages AS source ON source.id = map.source_message_id
      WHERE map.fork_id = ?
      ORDER BY map.ordinal
    `).all(fork.forkId) as Array<Record<string, unknown>>;
    for (const row of mappedRows) {
      expect(row.source_order_key).toBe(`${String(row.timestamp)}:${String(row.source_rowid)}`);
      expect(String(row.source_row_digest)).toMatch(/^[a-f0-9]{64}$/u);
    }
  });
});
