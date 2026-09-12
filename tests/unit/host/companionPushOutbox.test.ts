import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { CompanionPushOutbox } from '../../../src/host/services/companion/CompanionPushOutbox';
import { unwrapPushToken, wrapPushToken } from '../../../src/host/services/companion/companionPushProviders';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';

const wrapKey = Buffer.alloc(32, 7);

describe('CompanionPushOutbox', () => {
  let db: BetterSqlite3.Database;
  let gateway: CompanionGateway;
  let push: CompanionPushOutbox;
  let now: number;
  const sent: unknown[] = [];

  beforeEach(() => {
    db = new Database(':memory:');
    now = 1_000;
    sent.length = 0;
    const box: { push?: CompanionPushOutbox } = {};
    gateway = new CompanionGateway(db, {
      now: () => now,
      onPublish: event => box.push?.enqueue(event),
      onRevoke: deviceId => box.push?.forgetDevice(deviceId),
    });
    gateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
    push = new CompanionPushOutbox(db, gateway, { now: () => now, wrapKey, apnsKeyPath: null });
    box.push = push;
  });
  afterEach(() => db.close());

  function payloadOf(deviceId = 'phone-1') {
    const row = push.rowsFor(deviceId)[0];
    return JSON.parse(String(row.payload_json)) as Record<string, unknown>;
  }

  it('maps a companion completion event to a generalized outbox row', () => {
    const event = gateway.publish('session-1', 'agent_complete', { runId: 'run-1', title: 'Secret project', body: 'invoice $12' });
    const payload = payloadOf();
    expect(payload).toEqual({ titleKey: 'task_complete', kind: 'agent_complete', routeToken: payload.routeToken });
    expect(JSON.stringify(payload)).not.toContain('Secret');
    expect(JSON.stringify(payload)).not.toContain('invoice');
    expect(JSON.stringify(payload)).not.toContain('session-1');
    expect(push.rowsFor('phone-1')[0]).toMatchObject({ event_id: event.eventId, state: 'pending' });
  });

  it('does not copy approval preview or project names into the outbox payload', () => {
    gateway.publish('session-1', 'approval', { status: 'pending', preview: 'write /tmp/secret.txt', project: 'Alpha' });
    const payload = payloadOf();
    expect(payload).toEqual({ titleKey: 'approval_needed', kind: 'approval', routeToken: payload.routeToken });
    expect(JSON.stringify(payload)).not.toContain('secret');
    expect(JSON.stringify(payload)).not.toContain('Alpha');
    expect(JSON.stringify(payload)).not.toContain('/tmp');
  });

  it('ignores a duplicate event_id+device_id+kind', () => {
    const event = gateway.publish('session-1', 'agent_complete', {});
    push.enqueue(event);
    expect(push.rowsFor('phone-1')).toHaveLength(1);
  });

  it('does not enqueue for a revoked device', () => {
    gateway.revokeDevice('phone-1', 1_100);
    gateway.publish('session-1', 'agent_complete', {});
    expect(push.rowsFor('phone-1')).toEqual([]);
  });

  it('skips a pending row when the device is revoked before flush', async () => {
    push.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
    gateway.publish('session-1', 'agent_complete', {});
    gateway.revokeDevice('phone-1', 1_100);
    await push.flush();
    expect(push.rowsFor('phone-1')[0].state).toBe('skipped');
  });

  it('does not send when the session is no longer accessible', async () => {
    push.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
    gateway.publish('session-1', 'agent_complete', {});
    gateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash', scopeEpoch: 1, scope: ['other'], revokedAt: null });
    await push.flush();
    expect(push.rowsFor('phone-1')[0].state).toBe('skipped');
  });

  it('fails closed without fabricating a provider receipt when the APNs key is missing', async () => {
    push.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
    gateway.publish('session-1', 'agent_complete', {});
    await push.flush();
    expect(push.rowsFor('phone-1')[0].state).toBe('failed');
    expect(sent).toEqual([]);
  });

  it('fails Android FCM/vendor with missing GMS/vendor channel semantics', async () => {
    push.register('phone-1', { provider: 'fcm', token: 'device-token-aaaaaaaa', environment: 'production' });
    gateway.publish('session-1', 'error', {});
    await push.flush();
    expect(push.rowsFor('phone-1')[0].state).toBe('failed');
  });

  it('re-reads the live session when an expired notification is opened', () => {
    const event = gateway.publish('session-1', 'agent_complete', {});
    const token = payloadOf().routeToken as string;
    now = event.createdAt + L.pushTtlMs + 1;
    expect(push.open('phone-1', { routeToken: token })).toEqual({ kind: 'reread', sessionId: 'session-1' });
  });

  it('rejects opening after the device is revoked', () => {
    gateway.publish('session-1', 'agent_complete', {});
    const token = payloadOf().routeToken as string;
    gateway.revokeDevice('phone-1', 2_000);
    expect(push.open('phone-1', { routeToken: token })).toEqual({ kind: 'rejected', reason: 'device_revoked' });
  });

  it('rotates the stored token hash without keeping the previous wrap', () => {
    push.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
    const first = db.prepare('SELECT token_hash, token_wrap FROM companion_push_registrations WHERE device_id = ?').get('phone-1') as { token_hash: string; token_wrap: string };
    push.register('phone-1', { provider: 'apns', token: 'device-token-bbbbbbbb', environment: 'production' }, 2_000);
    const second = db.prepare('SELECT token_hash, token_wrap, updated_at FROM companion_push_registrations WHERE device_id = ?').get('phone-1') as { token_hash: string; token_wrap: string; updated_at: number };
    expect(second.token_hash).not.toBe(first.token_hash);
    expect(second.token_wrap).not.toBe(first.token_wrap);
    expect(second.updated_at).toBe(2_000);
    expect(unwrapPushToken(second.token_wrap, wrapKey)).toBe('device-token-bbbbbbbb');
  });

  it('deletes the registration on unregister', () => {
    push.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
    expect(push.unregister('phone-1')).toEqual({ kind: 'unregistered' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_push_registrations').get()).toEqual({ n: 0 });
  });

  it('sends only after re-checking revoke and access when a transport is injected', async () => {
    const sending = new CompanionPushOutbox(db, gateway, {
      now: () => now,
      wrapKey,
      apnsKeyPath: '/tmp/not-a-real-key.p8',
      send: async request => { sent.push({ provider: request.provider, payload: request.payload, token: request.token }); return { accepted: true }; },
    });
    sending.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
    gateway.publish('session-1', 'agent_complete', { title: 'must-not-leak' });
    await sending.flush();
    expect(sending.rowsFor('phone-1')[0].state).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain('must-not-leak');
    expect((sent[0] as { payload: { titleKey: string } }).payload.titleKey).toBe('task_complete');
  });

  it('serializes overlapping flush so one pending row is not sent twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sending = new CompanionPushOutbox(db, gateway, {
      now: () => now,
      wrapKey,
      apnsKeyPath: '/tmp/not-a-real-key.p8',
      send: async () => { sent.push('send'); await gate; return { accepted: true }; },
    });
    sending.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
    gateway.publish('session-1', 'agent_complete', {});
    const first = sending.flush();
    const second = sending.flush();
    release();
    await Promise.all([first, second]);
    expect(sent).toHaveLength(1);
    expect(sending.rowsFor('phone-1')[0].state).toBe('sent');
  });

  it('does not notify a closed approval', () => {
    gateway.publish('session-1', 'approval', { status: 'closed' });
    expect(push.rowsFor('phone-1')).toEqual([]);
  });

  it('wraps and unwraps a token', () => {
    const wrapped = wrapPushToken('device-token-aaaaaaaa', wrapKey);
    expect(wrapped).not.toContain('device-token');
    expect(unwrapPushToken(wrapped, wrapKey)).toBe('device-token-aaaaaaaa');
  });
});
