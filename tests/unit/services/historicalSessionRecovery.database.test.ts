import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { createLogger } from '../../../src/host/services/infra/logger';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { SessionForkRepository } from '../../../src/host/services/core/repositories/SessionForkRepository';
import { ConversationBranchRepository } from '../../../src/host/services/core/repositories/ConversationBranchRepository';
import { ConversationBranchAuditRepository } from '../../../src/host/services/core/repositories/ConversationBranchAuditRepository';
import { ConversationBranchLedgerStore } from '../../../src/host/services/core/repositories/ConversationBranchLedgerStore';
import { HistoricalSessionRecoveryRepository } from '../../../src/host/services/core/repositories/HistoricalSessionRecoveryRepository';

const source = 'cli_session_12345678_fixture';
const actor = 'fixture-owner';
describe('historical CLI import with real SQLite ledger and permissions', () => {
  let db: InstanceType<typeof Database>, sessions: SessionRepository, ledger: ConversationBranchRepository;
  let recovery: HistoricalSessionRecoveryRepository;
  const inspect = (sessionId = source, user: string | null = actor, projectId: string | null = null) =>
    recovery.recover(user, { sessionId, projectId, action: 'inspect' }, 100);
  const apply = (expectedDigest = inspect().sourceDigest) => recovery.recover(actor,
    { sessionId: source, projectId: null, action: 'import', expectedDigest }, 100);
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const original = () => Object.fromEntries(['sessions', 'messages', 'conversation_branches', 'conversation_entries', 'conversation_branch_entries', 'conversation_branch_events'].map((table) => [table, rows(table)]));
  const fork = (parentId: string, childId: string, anchorId = 'a1') => new SessionForkRepository(db, ledger).createFork({
    sourceSessionId: parentId, anchorAssistantMessageId: anchorId, idempotencyKey: `fork-${childId}`, ownerUserId: null,
    forkId: `fork-${childId}`, childSessionId: childId, childTitle: childId,
    workspaceMode: 'shared_current', contextDeliveryMode: 'neo_native_prefix', now: 30,
  });
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    const logger = createLogger('historicalRecoveryFixture');
    applySchema(db, logger); applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    sessions = new SessionRepository(db); ledger = new ConversationBranchRepository(db);
    recovery = new HistoricalSessionRecoveryRepository(db);
    sessions.createSession({ id: source, title: 'Fixture task', workingDirectory: '/fixture/workspace',
      modelConfig: { provider: 'openai', model: 'fixture-model' }, createdAt: 1, updatedAt: 1 } as never);
    sessions.addMessage(source, { id: 'u1', role: 'user', content: 'Remember the fixture number 42.', timestamp: 10 });
    sessions.addMessage(source, { id: 'a1', role: 'assistant', content: 'The fixture number is 42.', timestamp: 20 });
    // Reproduce the demo's incomplete session-only grant, never touch immutable rows.
    db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(actor, source);
  });
  afterEach(() => db.close());

  it('keeps dry-run read-only, imports without changing the source, and continues through normal ledger checks', () => {
    const before = original();
    expect(() => ledger.replayForLoad(source, { ownerUserId: actor, projectId: null })).toThrow(/OWNER_MISMATCH/);
    expect(inspect()).toMatchObject({ status: 'ready', historyReadable: true, targetContinuable: false, changes: { sessions: 1, messages: 2 } });
    expect(original()).toEqual(before);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='historical_session_recoveries'").get()).toBeUndefined();
    const result = apply(); expect(result.status).toBe('imported');
    const target = result.sessions![0].targetSessionId;
    expect(ledger.replayForLoad(target, { ownerUserId: actor, projectId: null }).messages.map((m) => m.message.content)).toEqual([
      'Remember the fixture number 42.', 'The fixture number is 42.',
    ]);
    sessions.addMessage(target, { id: 'follow-up', role: 'user', content: 'Continue the original task.', timestamp: 110 });
    expect(ledger.replay(target, { ownerUserId: actor, projectId: null }).messages).toHaveLength(3);
    for (const [table, oldRows] of Object.entries(before)) expect(rows(table).slice(0, oldRows.length)).toEqual(oldRows);
    expect(() => ledger.replay(source, { ownerUserId: actor, projectId: null })).toThrow(/OWNER_MISMATCH/);
    expect(() => ledger.replay(target, { ownerUserId: 'intruder', projectId: null })).toThrow(/OWNER_MISMATCH/);
    expect(() => db.prepare('UPDATE historical_session_recoveries SET source_digest = ?').run('tamper')).toThrow(/immutable/);
  });

  it.each([null, 'intruder'])('rejects unauthenticated/cross-user actor %s without mutations', (user) => {
    const before = original(); expect(inspect(source, user).status).toBe('rejected'); expect(original()).toEqual(before);
  });
  it('rejects a different project including null versus a named project', () => {
    expect(inspect(source, actor, 'other-project')).toMatchObject({ code: 'PROJECT_MISMATCH', historyReadable: false });
  });
  it('rejects a missing session grant despite an ownerless CLI ledger', () => {
    db.prepare('UPDATE sessions SET user_id = NULL').run(); expect(inspect().code).toBe('SESSION_ACCESS_DENIED');
  });
  it('rejects a forged author and modified compatibility payload', () => {
    db.prepare('UPDATE messages SET author_user_id = ? WHERE id = ?').run('intruder', 'u1');
    expect(inspect().code).toBe('MESSAGE_AUTHOR_OR_VISIBILITY_CONFLICT');
    db.prepare('UPDATE messages SET author_user_id = NULL, content = ? WHERE id = ?').run('tampered', 'u1');
    expect(inspect().code).toBe('SOURCE_LEDGER_INVALID');
  });
  it('rejects stale plans, then remains idempotent after continuation', () => {
    const plan = inspect(); db.prepare('UPDATE sessions SET title = ?').run('Changed');
    expect(apply(plan.sourceDigest).code).toBe('STALE_PLAN');
    const imported = apply(); const before = original();
    expect(apply()).toMatchObject({ status: 'already_imported', recoveryId: imported.recoveryId });
    expect(apply().changes).toEqual({ sessions: 0, messages: 0, branches: 0, entries: 0, references: 0, events: 0,
      forks: 0, forkMessageMappings: 0, receipts: 0, schemaObjects: 0 });
    expect(original()).toEqual(before); expect(rows('historical_session_recoveries')).toHaveLength(1);
  });
  it('stays idempotent after import when background sync touches sync-cursor columns, not content', () => {
    const imported = apply();
    // Simulate SessionRepository.markSessionsSynced/markMessagesSynced (syncService.ts)
    // and sessionRepositoryCrashRecovery.ts — both routinely mutate these columns on an
    // otherwise-idle session independent of conversation content.
    db.prepare("UPDATE sessions SET synced_at = ?, updated_at = ?, status = 'interrupted', last_token_usage = ? WHERE id = ?")
      .run(9999, 9999, JSON.stringify({ promptTokens: 1 }), source);
    db.prepare('UPDATE messages SET synced_at = ? WHERE session_id = ?').run(9999, source);
    const reinspected = inspect();
    expect(reinspected).toMatchObject({ status: 'already_imported', code: 'ALREADY_IMPORTED', recoveryId: imported.recoveryId });
    expect(reinspected.code).not.toBe('SOURCE_CHANGED_AFTER_IMPORT');
    expect(apply(reinspected.sourceDigest)).toMatchObject({ status: 'already_imported', recoveryId: imported.recoveryId });
  });
  it('rolls back sessions, branches, messages and receipt on a real SQLite write failure', () => {
    const before = original();
    db.exec(`CREATE TRIGGER fixture_fail BEFORE INSERT ON conversation_entries
      WHEN NEW.owner_user_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture disk write failure'); END;`);
    expect(apply().status).toBe('rejected'); expect(original()).toEqual(before);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='historical_session_recoveries'").get()).toBeUndefined();
    db.exec('DROP TRIGGER fixture_fail'); expect(apply().status).toBe('imported');
  });
  it('restores the closed parent/child graph and maps the shared prefix to the same new entry', () => {
    db.prepare('UPDATE sessions SET user_id = NULL').run();
    const child = new SessionForkRepository(db, ledger).createFork({ sourceSessionId: source,
      anchorAssistantMessageId: 'a1', idempotencyKey: 'fixture-fork', ownerUserId: null,
      forkId: 'fixture-fork', childSessionId: 'fixture-child', childTitle: 'Child',
      workspaceMode: 'shared_current', contextDeliveryMode: 'neo_native_prefix', now: 30 });
    sessions.addMessage(child.childSessionId, { id: 'child-user', role: 'user', content: 'Child follow-up', timestamp: 40 });
    db.prepare('UPDATE sessions SET user_id = ?').run(actor);
    const plan = inspect('fixture-child'); expect(plan, JSON.stringify(plan)).toMatchObject({ status: 'ready' }); expect(plan.sessions).toHaveLength(2);
    const result = apply(plan.sourceDigest); expect(result.status).toBe('imported');
    const rootId = result.sessions!.find((item) => item.sourceSessionId === source)!.targetSessionId;
    const childId = result.sessions!.find((item) => item.sourceSessionId === 'fixture-child')!.targetSessionId;
    const boundary = { ownerUserId: actor, projectId: null };
    const rootReplay = ledger.replay(rootId, boundary), childReplay = ledger.replayForLoad(childId, boundary);
    expect(childReplay.lineage.parentBranchId).toBe(rootReplay.lineage.branchId);
    expect(childReplay.messages[0].entryId).toBe(rootReplay.messages[0].entryId);
    expect(childReplay.messages).toHaveLength(3);
    expect(new SessionForkRepository(db, ledger).getLineage(childId)).toBeDefined();
    expect(sessions.getSession(childId)?.metadata?.forkLineage).toMatchObject({ parentSessionId: rootId });
    db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run('intruder', 'fixture-child');
    expect(inspect().code).toBe('GRAPH_OWNER_MISMATCH');
  });
  it('imports siblings and a grandchild once, retaining all parent and shared-prefix associations', () => {
    db.prepare('UPDATE sessions SET user_id = NULL').run();
    const first = fork(source, 'child-one'); fork(source, 'child-two');
    fork('child-one', 'grandchild', first.messageMappings[1].childMessageId);
    db.prepare('UPDATE sessions SET user_id = ?').run(actor);
    const audit = new ConversationBranchAuditRepository(db, new ConversationBranchLedgerStore(db))
      .auditHistoricalImportSource('grandchild', { ownerUserId: actor, projectId: null });
    expect(audit.issues).toEqual([]);
    const plan = inspect('grandchild'); expect(plan, JSON.stringify(plan)).toMatchObject({ status: 'ready', changes: { branches: 4, forks: 3, forkMessageMappings: 6 } });
    const imported = apply(plan.sourceDigest); expect(imported.status).toBe('imported');
    const targets = Object.fromEntries(imported.sessions!.map((item) => [item.sourceSessionId, item.targetSessionId]));
    const forkRepo = new SessionForkRepository(db, ledger);
    expect(forkRepo.listChildren(targets[source], actor)).toHaveLength(2);
    expect(forkRepo.getLineage(targets.grandchild, actor)?.parentSessionId).toBe(targets['child-one']);
    expect(forkRepo.getContextSource(targets.grandchild)?.mappedActivePrefix).toHaveLength(2);
    expect(apply().status).toBe('already_imported');
  });
  it('rejects missing fork mappings even when immutable references still replay', () => {
    db.prepare('UPDATE sessions SET user_id = NULL').run(); fork(source, 'child');
    db.prepare('UPDATE sessions SET user_id = ?').run(actor);
    db.prepare('DELETE FROM session_fork_message_map').run();
    expect(inspect()).toMatchObject({ status: 'rejected', code: 'CONTEXT_HANDOFF_REJECTED' });
  });
  it('rejects conflicting fork metadata and isolated workspace forks', () => {
    db.prepare('UPDATE sessions SET user_id = NULL').run(); fork(source, 'child');
    db.prepare('UPDATE sessions SET user_id = ?').run(actor);
    db.prepare("UPDATE session_forks SET root_session_id = 'child'").run();
    expect(inspect().code).toBe('FORK_EVIDENCE_REQUIRED');
    db.prepare("UPDATE session_forks SET root_session_id = ?, workspace_mode = 'isolated_at_anchor'").run(source);
    expect(inspect().code).toBe('FORK_EVIDENCE_REQUIRED');
  });
  it('rejects children outside the immutable graph', () => {
    sessions.createSession({ id: 'external-child', title: 'External child', userId: actor,
      parentSessionId: source, modelConfig: { provider: 'openai', model: 'fixture-model' }, createdAt: 1, updatedAt: 1 } as never);
    expect(inspect().code).toBe('GRAPH_NOT_CLOSED');
  });
  it.each(['created', 'running', 'waiting', 'paused', 'recovering', 'unknown_future_state'])('rejects idle sessions with nonterminal durable run %s', (status) => {
    db.exec('CREATE TABLE durable_runs (run_id TEXT, session_id TEXT, status TEXT)');
    db.prepare('INSERT INTO durable_runs VALUES (?, ?, ?)').run('run-fixture', source, status);
    expect(inspect().code).toBe('SOURCE_RUN_ACTIVE');
  });
  it('rolls back even when final receipt insertion fails, then retries safely', () => {
    db.exec(`CREATE TABLE historical_session_recoveries (
      id TEXT PRIMARY KEY, actor_user_id TEXT, source_digest TEXT, manifest_json TEXT, created_at INTEGER);
      CREATE TRIGGER fixture_receipt_fail BEFORE INSERT ON historical_session_recoveries
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END;`);
    const before = original(); expect(apply().status).toBe('rejected'); expect(original()).toEqual(before);
    expect(rows('historical_session_recoveries')).toHaveLength(0);
    db.exec('DROP TRIGGER fixture_receipt_fail'); expect(apply().status).toBe('imported');
  });
  it('detects invalid target projection on repeated import without making another copy', () => {
    const imported = apply(); const target = imported.sessions![0].targetSessionId;
    db.prepare('UPDATE messages SET content = ? WHERE session_id = ?').run('tampered target', target);
    expect(apply()).toMatchObject({ status: 'rejected', targetContinuable: false });
    expect(rows('sessions')).toHaveLength(2);
  });
  it('reports a busy imported target separately from ownership recovery', () => {
    const imported = apply(); const target = imported.sessions![0].targetSessionId;
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(target);
    expect(apply()).toMatchObject({ status: 'already_imported', code: 'TARGET_NOT_IDLE', targetContinuable: false });
    expect(rows('historical_session_recoveries')).toHaveLength(1);
  });
  it('rejects a source entry shared with a branch outside its root graph', () => {
    sessions.createSession({ id: 'other-root', title: 'Other root', userId: actor,
      modelConfig: { provider: 'openai', model: 'fixture-model' }, createdAt: 1, updatedAt: 1 } as never);
    const other = ledger.initializeSessionBranch({ sessionId: 'other-root', boundary: { ownerUserId: actor, projectId: null } });
    db.prepare(`INSERT INTO conversation_branch_entries
      SELECT ?, ordinal, entry_id, 'other-root', 'other-message', canonical_source_session_id,
        canonical_source_message_id, alias_kind, created_at FROM conversation_branch_entries
      WHERE projected_message_id = 'u1'`).run(other.branchId);
    expect(inspect().code).toBe('ENTRY_SHARED_OUTSIDE_GRAPH');
  });
  it('imports a granted CLI history in its exact active named project', () => {
    const project = 'fixture-project', id = 'cli_session_12345679_project';
    db.prepare('INSERT INTO projects (id,name,status,created_at,updated_at) VALUES (?, ?, ?, ?, ?)').run(project, 'Fixture project', 'active', 1, 1);
    sessions.createSession({ id, projectId: project, title: 'Project task', workingDirectory: '/fixture/project',
      modelConfig: { provider: 'openai', model: 'fixture-model' }, createdAt: 1, updatedAt: 1 } as never);
    sessions.addMessage(id, { id: 'project-user', role: 'user', content: 'Read project history', timestamp: 10 });
    db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(actor, id);
    expect(inspect(id, actor, null).code).toBe('PROJECT_MISMATCH');
    const plan = inspect(id, actor, project); expect(plan.status).toBe('ready');
    const imported = recovery.recover(actor, { sessionId: id, projectId: project, action: 'import', expectedDigest: plan.sourceDigest });
    expect(imported.status).toBe('imported');
    expect(ledger.replay(imported.sessions![0].targetSessionId, { ownerUserId: actor, projectId: project }).messages).toHaveLength(1);
    db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(project);
    expect(inspect(id, actor, project).code).toBe('PROJECT_UNAVAILABLE');
  });
});
