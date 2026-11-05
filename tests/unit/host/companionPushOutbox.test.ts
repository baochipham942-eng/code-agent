import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { CompanionPushOutbox } from '../../../src/host/services/companion/CompanionPushOutbox';
import { unwrapPushToken, wrapPushToken } from '../../../src/host/services/companion/companionPushProviders';
import { desktopPresence } from '../../../src/host/services/companion/desktopPresence';
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

  it('does not delete a registration that rotated while a dead-token send was in flight', async () => {
    const box: { push?: CompanionPushOutbox } = {};
    const sending = new CompanionPushOutbox(db, gateway, {
      now: () => now,
      wrapKey,
      apnsKeyPath: '/tmp/not-a-real-key.p8',
      send: async () => {
        box.push?.register('phone-1', { provider: 'apns', token: 'device-token-bbbbbbbb', environment: 'production' }, 2_000);
        return { accepted: false, code: 'NOT_REGISTERED' };
      },
    });
    box.push = sending;
    sending.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
    gateway.publish('session-1', 'agent_complete', {});
    await sending.flush();
    expect(sending.rowsFor('phone-1')[0].state).toBe('failed');
    const row = db.prepare('SELECT token_wrap FROM companion_push_registrations WHERE device_id = ?').get('phone-1') as { token_wrap: string };
    expect(unwrapPushToken(row.token_wrap, wrapKey)).toBe('device-token-bbbbbbbb');
  });

  it('does not retry a dead APNs token after NOT_REGISTERED', async () => {
    const sending = new CompanionPushOutbox(db, gateway, {
      now: () => now,
      wrapKey,
      apnsKeyPath: '/tmp/not-a-real-key.p8',
      send: async request => { sent.push(request.token); return { accepted: false, code: 'NOT_REGISTERED' }; },
    });
    sending.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
    gateway.publish('session-1', 'agent_complete', {});
    await sending.flush();
    expect(sending.rowsFor('phone-1')[0].state).toBe('failed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_push_registrations').get()).toEqual({ n: 0 });
    gateway.publish('session-1', 'error', {});
    await sending.flush();
    expect(sent).toEqual(['device-token-aaaaaaaa']);
    expect(sending.rowsFor('phone-1').map(row => row.state)).toEqual(['failed', 'failed']);
  });

  it('keeps a retryable provider failure pending and waits Retry-After', async () => {
    const sending = new CompanionPushOutbox(db, gateway, {
      now: () => now,
      wrapKey,
      apnsKeyPath: '/tmp/not-a-real-key.p8',
      send: async () => { sent.push(now); return { accepted: false, code: 'PROVIDER_RETRY', retryAfterMs: 5_000 }; },
    });
    sending.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
    gateway.publish('session-1', 'agent_complete', {});
    await sending.flush();
    expect(sending.rowsFor('phone-1')[0]).toMatchObject({ state: 'pending', attempts: 1 });
    now = 5_999;
    await sending.flush();
    expect(sent).toEqual([1_000]);
    now = 6_000;
    await sending.flush();
    expect(sent).toEqual([1_000, 6_000]);
    expect(sending.rowsFor('phone-1')[0].attempts).toBe(2);
  });

  // ============================================================================
  // 桌面在场抑制（N-NOTIFY-PRESENCE-HEARTBEAT ②③）：真 desktopPresence 单例接线，
  // 独立 gateway 保证 enqueue 走的是带 presence 的 outbox（共享 db 的既有先例：
  // 「registration rotated while in flight」同款第二网关法）。
  // ============================================================================
  describe('desktop presence suppression', () => {
    function buildPresenceOutbox(scope: string[]) {
      const box: { push?: CompanionPushOutbox } = {};
      const presenceGateway = new CompanionGateway(db, {
        now: () => now,
        onPublish: event => box.push?.enqueue(event),
        onRevoke: deviceId => box.push?.forgetDevice(deviceId),
      });
      presenceGateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash', scopeEpoch: 1, scope, revokedAt: null });
      const outbox = new CompanionPushOutbox(db, presenceGateway, {
        now: () => now,
        wrapKey,
        apnsKeyPath: '/tmp/not-a-real-key.p8',
        send: async request => { sent.push(request.payload.titleKey); return { accepted: true }; },
        presence: desktopPresence,
      });
      box.push = outbox;
      return outbox;
    }

    it('② agent_complete 在场时不入队，窗口过期后恢复入队', () => {
      const outbox = buildPresenceOutbox(['session-1']);
      desktopPresence.report({ visible: true, focused: true, lastInputAt: now }, now);
      outbox.enqueue({ eventId: 'evt-active-1', epoch: 1, seq: 1, sessionId: 'session-1', kind: 'agent_complete', payload: {}, createdAt: now });
      expect(outbox.rowsFor('phone-1')).toEqual([]);
      now += L.desktopPresenceFreshMs + 1;
      outbox.enqueue({ eventId: 'evt-active-2', epoch: 1, seq: 2, sessionId: 'session-1', kind: 'agent_complete', payload: {}, createdAt: now });
      expect(outbox.rowsFor('phone-1')).toHaveLength(1);
      expect(outbox.rowsFor('phone-1')[0]).toMatchObject({ event_id: 'evt-active-2', state: 'pending' });
    });

    it('② 紧急类不看在场：approval(pending) 与 error 在场时照样入队', () => {
      const outbox = buildPresenceOutbox(['session-1']);
      desktopPresence.report({ visible: true, focused: true, lastInputAt: now }, now);
      expect(desktopPresence.isActive(now)).toBe(true);
      outbox.enqueue({ eventId: 'evt-approval-1', epoch: 1, seq: 1, sessionId: 'session-1', kind: 'approval', payload: { status: 'pending' }, createdAt: now });
      outbox.enqueue({ eventId: 'evt-error-1', epoch: 1, seq: 2, sessionId: 'session-1', kind: 'error', payload: {}, createdAt: now });
      expect(outbox.rowsFor('phone-1').map(row => row.kind)).toEqual(['approval', 'error']);
      expect(outbox.rowsFor('phone-1').every(row => row.state === 'pending')).toBe(true);
    });

    it('③ 单向已读：入队后桌面看过该会话 → pending 行 skipped；另一会话的行照发', async () => {
      const outbox = buildPresenceOutbox(['presence-read-a', 'presence-read-b']);
      outbox.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
      // 入队时刻必须不在场（否则 enqueue 就压掉了，测不到 pending→skipped 路径）
      desktopPresence.report({ visible: false, focused: false, lastInputAt: now }, now);
      outbox.enqueue({ eventId: 'evt-read-a', epoch: 1, seq: 1, sessionId: 'presence-read-a', kind: 'agent_complete', payload: {}, createdAt: now });
      outbox.enqueue({ eventId: 'evt-read-b', epoch: 1, seq: 2, sessionId: 'presence-read-b', kind: 'agent_complete', payload: {}, createdAt: now });
      // 桌面在事件落队之后打开了会话 presence-read-a（单向已读）
      now += 4_000;
      desktopPresence.report({ visible: true, focused: true, lastInputAt: now, viewingSessionId: 'presence-read-a' }, now);
      await outbox.flush();
      const states = db.prepare('SELECT session_id, state FROM companion_push_outbox ORDER BY session_id').all() as Array<{ session_id: string; state: string }>;
      expect(states).toEqual([
        { session_id: 'presence-read-a', state: 'skipped' },
        { session_id: 'presence-read-b', state: 'sent' },
      ]);
      expect(sent).toEqual(['task_complete']);
    });

    // r1 返修（评审 Important）：首推 PROVIDER_RETRY 进重试等待；等待期间用户切走
    // （失焦），隐藏窗口的心跳仍带 viewingSessionId —— 不得盖章已读把 pending 行盖成
    // skipped（手机没收到、桌面也没人看，通知双丢）。行必须在重试后照常 sent。
    it('r1 重试等待期的失焦心跳不得把 pending 完成推送盖成 skipped', async () => {
      const box: { push?: CompanionPushOutbox } = {};
      const blindGateway = new CompanionGateway(db, {
        now: () => now,
        onPublish: event => box.push?.enqueue(event),
        onRevoke: deviceId => box.push?.forgetDevice(deviceId),
      });
      blindGateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash', scopeEpoch: 1, scope: ['presence-blind-x'], revokedAt: null });
      let attempts = 0;
      const outbox = new CompanionPushOutbox(db, blindGateway, {
        now: () => now,
        wrapKey,
        apnsKeyPath: '/tmp/not-a-real-key.p8',
        presence: desktopPresence,
        send: async request => {
          attempts += 1;
          sent.push(request.payload.titleKey);
          return attempts === 1
            ? { accepted: false, code: 'PROVIDER_RETRY', retryAfterMs: 5_000 }
            : { accepted: true };
        },
      });
      box.push = outbox;
      outbox.register('phone-1', { provider: 'apns', token: 'device-token-aaaaaaaa', environment: 'production' });
      // 用户已切走（失焦但 currentSessionId 未变）：完成事件照常入队
      desktopPresence.report({ visible: true, focused: false, lastInputAt: now }, now);
      outbox.enqueue({ eventId: 'evt-blind-1', epoch: 1, seq: 1, sessionId: 'presence-blind-x', kind: 'agent_complete', payload: {}, createdAt: now });
      // 首推 PROVIDER_RETRY → pending 等重试
      await outbox.flush();
      expect(outbox.rowsFor('phone-1')[0]).toMatchObject({ state: 'pending', attempts: 1 });
      // 重试等待期内隐藏窗口的心跳（viewingSessionId 仍是被看的那个会话，时间 ≥ created_at）
      now += 6_000;
      desktopPresence.report({ visible: true, focused: false, lastInputAt: now, viewingSessionId: 'presence-blind-x' }, now);
      await outbox.flush();
      expect(outbox.rowsFor('phone-1')[0]).toMatchObject({ state: 'sent', attempts: 2 });
      expect(sent).toEqual(['task_complete', 'task_complete']);
    });
  });
});
