import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/companion/CompanionGateway';

describe('CompanionGateway', () => {
  let db: BetterSqlite3.Database;
  let gateway: CompanionGateway;

  beforeEach(() => {
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, { now: () => 1000 });
    gateway.registerDevice({ deviceId: 'phone-1', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
  });

  afterEach(() => db.close());

  it('accepts a command once and replays the durable result', () => {
    const dispatch = vi.fn(() => ({ state: 'accepted' as const, result: { runId: 'run-1' } }));
    gateway = new CompanionGateway(db, { now: () => 1000, dispatch });
    gateway.registerDevice({ deviceId: 'phone-1', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
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
    gateway.registerDecision({ requestId: 'req-1', sessionId: 'session-1', revision: 4, status: 'pending', resolvedBy: null, operationDigest: null });
    const command = { version: 1 as const, commandId: 'approve-1', deviceId: 'phone-1', scopeEpoch: 1, sessionId: 'session-1', action: 'approval.respond' as const, expectedRevision: 4, payload: { requestId: 'req-1', decision: 'approved', operationDigest: 'digest-1' } };
    expect(gateway.submit(command).kind).toBe('accepted');
    expect(gateway.submit({ ...command, commandId: 'approve-2' }).kind).toBe('approval_conflict');
  });

  it('rejects revoked devices before dispatch', () => {
    gateway.revokeDevice('phone-1', 1100);
    expect(gateway.submit({ version: 1, commandId: 'cmd-1', deviceId: 'phone-1', scopeEpoch: 2, sessionId: 'session-1', action: 'run.cancel', payload: { runId: 'run-1' } })).toEqual({ kind: 'rejected', reason: 'device_revoked' });
  });
});
