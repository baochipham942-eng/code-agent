import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';

describe('CompanionGateway', () => {
  let db: BetterSqlite3.Database;
  let gateway: CompanionGateway;

  beforeEach(() => {
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, { now: () => 1000 });
    gateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash-phone-1', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
  });

  afterEach(() => db.close());

  it('accepts a command once and replays the durable result', () => {
    const dispatch = vi.fn(() => ({ state: 'accepted' as const, result: { runId: 'run-1' } }));
    gateway = new CompanionGateway(db, { now: () => 1000, dispatch });
    gateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash-phone-1', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
    const command = { version: 1 as const, commandId: 'cmd-1', deviceId: 'phone-1', scopeEpoch: 1, sessionId: 'session-1', action: 'message.send' as const, payload: { text: 'hello' } };
    expect(gateway.submit(command).kind).toBe('accepted');
    expect(gateway.submit(command).kind).toBe('replayed');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects same command id with a different payload', () => {
    const base = { version: 1 as const, commandId: 'cmd-1', deviceId: 'phone-1', scopeEpoch: 1, sessionId: 'session-1', action: 'message.send' as const };
    gateway.submit({ ...base, payload: { text: 'one' } });
    expect(gateway.submit({ ...base, payload: { text: 'two' } })).toEqual({ kind: 'conflict', reason: 'command_payload_mismatch' });
  });

  it('returns a gap-free event watermark and requests a snapshot after epoch change', () => {
    gateway.publish('session-1', 'message', { id: 'm1' });
    gateway.publish('session-1', 'message', { id: 'm2' });
    expect(gateway.sync(1, 0).events.map((event) => event.seq)).toEqual([1, 2]);
    gateway.revokeDevice('phone-1', 1100);
    expect(gateway.sync(1, 2).kind).toBe('snapshot_required');
  });

  it('allows only the first approval decision for a revision', () => {
    const decide = vi.fn((cmd: import('../../../src/shared/contract/companion').CompanionCommand) => {
      gateway.registerDecision({ requestId: 'req-1', sessionId: 'session-1', revision: 4, status: 'approved', resolvedBy: cmd.deviceId, operationDigest: 'digest-1' });
      return { kind: 'accepted' as const, command: { deviceId: cmd.deviceId, commandId: cmd.commandId, payloadHash: '', action: cmd.action, sessionId: cmd.sessionId, state: 'resolved' as const, result: { approved: true }, createdAt: 1000 } };
    });
    gateway = new CompanionGateway(db, { now: () => 1000, decide });
    gateway.registerDecision({ requestId: 'req-1', sessionId: 'session-1', revision: 4, status: 'pending', resolvedBy: null, operationDigest: 'digest-1' });
    const command = { version: 1 as const, commandId: 'approve-1', deviceId: 'phone-1', scopeEpoch: 1, sessionId: 'session-1', action: 'approval.respond' as const, expectedRevision: 4, payload: { requestId: 'req-1', decision: 'approved', operationDigest: 'digest-1' } };
    expect(gateway.submit(command).kind).toBe('accepted');
    expect(gateway.submit({ ...command, commandId: 'approve-2' }).kind).toBe('approval_conflict');
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('rejects revoked devices before dispatch', () => {
    gateway.revokeDevice('phone-1', 1100);
    expect(gateway.submit({ version: 1, commandId: 'cmd-1', deviceId: 'phone-1', scopeEpoch: 2, sessionId: 'session-1', action: 'run.cancel', payload: { runId: 'run-1' } })).toEqual({ kind: 'rejected', reason: 'device_revoked' });
  });

  it('authenticates the device credential separately from the desktop API token', () => {
    const credentialHash = createHash('sha256').update('abc').digest('hex');
    gateway.registerDevice({ deviceId: 'phone-2', credentialHash, scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
    expect(gateway.authenticateDevice('phone-2', 'abc')).toBe(true);
    expect(gateway.authenticateDevice('phone-2', 'desktop-bearer')).toBe(false);
  });

  it('issues a device credential without persisting the raw secret', () => {
    const issued = gateway.issueDeviceCredential(['session-1']);
    expect(issued.deviceId).toMatch(/^phone-/);
    expect(issued.credential.length).toBeGreaterThan(32);
    expect(gateway.authenticateDevice(issued.deviceId, issued.credential)).toBe(true);
    const row = db.prepare('SELECT credential_hash FROM companion_devices WHERE device_id = ?').get(issued.deviceId) as { credential_hash: string };
    expect(row.credential_hash).not.toBe(issued.credential);
  });
  it('persists a logical approval claim before an uncertain callback', () => {
    const decide = vi.fn(() => { throw new Error('side effect outcome unknown'); });
    gateway = new CompanionGateway(db, { decide });
    gateway.registerDecision({ requestId: 'request', sessionId: 'session-1', revision: 1, status: 'pending', resolvedBy: null, operationDigest: 'digest' });
    const command = { version: 1, commandId: 'first', deviceId: 'phone-1', scopeEpoch: 1, sessionId: 'session-1', action: 'approval.respond', expectedRevision: 1,
      payload: { requestId: 'request', decision: 'approved', operationDigest: 'digest' } };
    gateway.submit(command);
    gateway = new CompanionGateway(db, { decide });
    gateway.submit({ ...command, commandId: 'second' });
    expect(decide).toHaveBeenCalledTimes(2);
    expect(gateway.commandStatus('phone-1', 'second')?.state).toBe('reconciling');
  });

  it.each([
    ['message.send', { text: 'hello' }],
    ['run.cancel', { runId: 'run-1' }],
    ['approval.respond', { requestId: 'request', decision: 'approved', operationDigest: 'digest' }],
    ['files.prepare', { name: 'photo.png', mimeType: 'image/png', size: 4, sha256: 'a'.repeat(64) }],
  ] as const)('recovers an interrupted %s reservation on host restart', (action, payload) => {
    const first = new CompanionGateway(db, { now: () => 1000, dispatch: () => ({ state: 'reconciling' }),
      decide: action === 'approval.respond' ? (() => { throw new Error('uncertain'); }) : undefined });
    first.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash-phone-1', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
    const command = { version: 1 as const, commandId: `interrupted-${action}`, deviceId: 'phone-1', scopeEpoch: 1,
      sessionId: 'session-1', action, ...(action === 'approval.respond' ? { expectedRevision: 1 } : {}), payload } as const;
    if (action === 'approval.respond') first.registerDecision({ requestId: 'request', sessionId: 'session-1', revision: 1, status: 'pending', resolvedBy: null, operationDigest: 'digest' });
    expect(first.submit(command).kind).toBe(action === 'approval.respond' ? 'replayed' : 'accepted');
    const restarted = new CompanionGateway(db);
    expect(restarted.commandStatus('phone-1', command.commandId)).toMatchObject({ state: 'rejected', result: { code: 'COMPANION_INTERRUPTED' } });
  });

  it('releases an interrupted approval claim so a new command ID can retry', () => {
    let attempts = 0;
    const decide = vi.fn((command: any) => {
      attempts += 1;
      if (attempts === 1) throw new Error('uncertain');
      return { kind: 'accepted' as const, command: { deviceId: command.deviceId, commandId: command.commandId, payloadHash: '', action: command.action, sessionId: command.sessionId, state: 'resolved' as const, result: { approved: true }, createdAt: 1000 } };
    });
    const first = new CompanionGateway(db, { decide });
    first.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash-phone-1', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
    first.registerDecision({ requestId: 'retry-request', sessionId: 'session-1', revision: 1, status: 'pending', resolvedBy: null, operationDigest: 'retry-digest' });
    const base = { version: 1 as const, deviceId: 'phone-1', scopeEpoch: 1, sessionId: 'session-1', action: 'approval.respond' as const, expectedRevision: 1, payload: { requestId: 'retry-request', decision: 'approved' as const, operationDigest: 'retry-digest' } };
    expect(first.submit({ ...base, commandId: 'retry-one' }).kind).toBe('replayed');
    const restarted = new CompanionGateway(db, { decide });
    expect(restarted.submit({ ...base, commandId: 'retry-two' })).toMatchObject({ kind: 'accepted', command: { state: 'resolved' } });
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it('does not persist companion_events when no live device remains', () => {
    db.close();
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, { now: () => 1000 });
    gateway.publish('session-1', 'message', { content: 'never-paired' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_events').get()).toEqual({ n: 0 });
    gateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash-phone-1', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
    gateway.publish('session-1', 'message', { content: 'after-pair' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_events').get()).toEqual({ n: 1 });
    gateway.revokeDevice('phone-1', 1100);
    gateway.publish('session-1', 'message', { content: 'after-revoke' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_events').get()).toEqual({ n: 0 });
  });

  it('physically deletes companion_events when a session is forgotten', () => {
    gateway.publish('session-1', 'message', { content: 'secret-body' });
    gateway.publish('session-1', 'tool_call_start', { id: 't1', name: 'read_file' });
    gateway.forgetSession('session-1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_events').get()).toEqual({ n: 0 });
    expect(gateway.syncForDevice('phone-1', 1, 0).events).toEqual([]);
    expect(gateway.canAccessSession('phone-1', 'session-1')).toBe(false);
  });

  it('hides leftover companion_events for a deleted session before rows are gone', () => {
    const live = new Set(['session-1']);
    gateway = new CompanionGateway(db, { now: () => 1000, sessionVisible: id => live.has(id) });
    gateway.publish('session-1', 'message', { content: 'deleted-body' });
    live.delete('session-1');
    expect(gateway.canAccessSession('phone-1', 'session-1')).toBe(false);
    expect(gateway.syncForDevice('phone-1', 1, 0).events).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_events').get()).toEqual({ n: 1 });
  });

  it('filters leftover rows queued on companion_session_cleanup even without sessionVisible', () => {
    gateway.publish('session-1', 'message', { content: 'queued-deleted' });
    db.prepare('INSERT INTO companion_session_cleanup (session_id) VALUES (?)').run('session-1');
    expect(gateway.syncForDevice('phone-1', 1, 0).events).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_events').get()).toEqual({ n: 1 });
  });

  it('deletes companion_events inside the session.delete mutation receipt', () => {
    const dispatch = vi.fn(() => ({ state: 'reconciling' as const }));
    gateway = new CompanionGateway(db, { now: () => 1000, dispatch });
    gateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash-phone-1', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
    gateway.publish('session-1', 'message', { content: 'to-delete' });
    const command = { version: 1 as const, commandId: 'del-1', deviceId: 'phone-1', scopeEpoch: 1, sessionId: 'session-1', action: 'session.delete' as const, payload: {} };
    expect(gateway.submit(command).kind).toBe('accepted');
    gateway.commitMutation(command, () => {}, { sessionId: 'session-1' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_events').get()).toEqual({ n: 0 });
    expect(gateway.syncForDevice('phone-1', 1, 0).events).toEqual([]);
  });

  it('cascades companion_events when the sessions tombstone is written', () => {
    db.close();
    db = new Database(':memory:');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, is_deleted INTEGER NOT NULL DEFAULT 0)');
    gateway = new CompanionGateway(db, { now: () => 1000 });
    gateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash-phone-1', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
    db.prepare('INSERT INTO sessions (id, is_deleted) VALUES (?, 0)').run('session-1');
    gateway.publish('session-1', 'message', { content: 'tombstone-me' });
    db.prepare('UPDATE sessions SET is_deleted = 1 WHERE id = ?').run('session-1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_events').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT session_id FROM companion_session_cleanup').all()).toEqual([{ session_id: 'session-1' }]);
    expect(gateway.syncForDevice('phone-1', 1, 0).events).toEqual([]);
  });

  it('physically deletes expired companion_events', () => {
    let now = 1_000;
    gateway = new CompanionGateway(db, { now: () => now });
    gateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash-phone-1', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
    gateway.publish('session-1', 'message', { id: 'expired' });
    now = 1_000 + COMPANION_LIMITS.eventTtlMs + 1;
    gateway.publish('session-1', 'message', { id: 'fresh' });
    expect(db.prepare('SELECT payload_json FROM companion_events').all()).toEqual([{ payload_json: '{"id":"fresh"}' }]);
  });

  it('physically deletes over-cap companion_events oldest first', () => {
    const extra = 7;
    db.transaction(() => {
      const stmt = db.prepare(`INSERT INTO companion_events (event_id, epoch, seq, session_id, kind, payload_json, created_at) VALUES (?, 1, ?, 'session-1', 'message', '{}', ?)`);
      for (let i = 1; i <= COMPANION_LIMITS.eventMaxRows + extra; i++) stmt.run(`cap-${i}`, i, 2_000 + i);
    })();
    gateway.publish('session-1', 'message', { id: 'cap-trigger' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_events').get()).toEqual({ n: COMPANION_LIMITS.eventMaxRows });
    expect(db.prepare('SELECT 1 AS ok FROM companion_events WHERE event_id = ?').get('cap-1')).toBeUndefined();
  });

});
