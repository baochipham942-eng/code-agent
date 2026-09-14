import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { CompanionPushOutbox } from '../../src/host/services/companion/CompanionPushOutbox';
import { companionApnsOutboxTransport } from '../../src/host/services/companion/companionApnsProvider';
import { COMPANION_APNS } from '../../src/shared/constants/companion';
import { listenFakeApns, writeTempApnsKey, writeTempApnsPem } from '../unit/host/fakeApnsServer';

const wrapKey = Buffer.alloc(32, 9);
const DEVICE_TOKEN = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const KEY_ID = 'TESTKEYID1';
const TEAM_ID = 'TESTTEAM01';
const BUNDLE_ID = 'dev.neo.companion.test';

describe('companion APNs: outbox + local http2 fake APNs', () => {
  let db: BetterSqlite3.Database;
  let gateway: CompanionGateway;
  let now: number;
  const box: { push?: CompanionPushOutbox } = {};
  const cleanup: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    db = new Database(':memory:');
    now = 1_000;
    box.push = undefined;
    gateway = new CompanionGateway(db, {
      now: () => now,
      onPublish: event => box.push?.enqueue(event),
      onRevoke: deviceId => box.push?.forgetDevice(deviceId),
    });
    gateway.registerDevice({ deviceId: 'phone-1', credentialHash: 'hash', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
  });
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()?.();
    db.close();
  });

  function attach(transport: ReturnType<typeof companionApnsOutboxTransport>): CompanionPushOutbox {
    const push = new CompanionPushOutbox(db, gateway, {
      now: () => now,
      wrapKey,
      apnsKeyPath: transport.apnsKeyPath,
      send: transport.send,
    });
    box.push = push;
    return push;
  }

  function envFor(keyPath: string) {
    return {
      NEO_APNS_KEY_PATH: keyPath,
      NEO_APNS_KEY_ID: KEY_ID,
      NEO_APNS_TEAM_ID: TEAM_ID,
      NEO_APNS_BUNDLE_ID: BUNDLE_ID,
      NEO_APNS_ENV: 'production',
    };
  }

  it('marks the outbox sent only after the fake APNs accepts the unwrapped token', async () => {
    const key = writeTempApnsKey();
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop(), () => rmSync(key.dir, { recursive: true, force: true }));
    const push = attach(companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority }));
    push.register('phone-1', { provider: 'apns', token: DEVICE_TOKEN, environment: 'production' });
    gateway.publish('session-1', 'agent_complete', { title: 'must-not-leak' });
    await push.flush();
    expect(push.rowsFor('phone-1')[0].state).toBe('sent');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].path).toBe(`${COMPANION_APNS.pathPrefix}${DEVICE_TOKEN}`);
    expect(fake.requests[0].body).not.toContain('must-not-leak');
    expect(JSON.stringify(fake.requests)).not.toContain('BEGIN PRIVATE KEY');
  });

  it('drops a dead token after 410 so the outbox does not retry it', async () => {
    const key = writeTempApnsKey();
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop(), () => rmSync(key.dir, { recursive: true, force: true }));
    fake.handler = (_req, res) => {
      res.writeHead(410, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reason: 'Unregistered' }));
    };
    const push = attach(companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority }));
    push.register('phone-1', { provider: 'apns', token: DEVICE_TOKEN, environment: 'production' });
    gateway.publish('session-1', 'agent_complete', {});
    await push.flush();
    expect(push.rowsFor('phone-1')[0].state).toBe('failed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_push_registrations').get()).toEqual({ n: 0 });
    expect(fake.requests).toHaveLength(1);
    gateway.publish('session-1', 'error', {});
    await push.flush();
    expect(fake.requests).toHaveLength(1);
    expect(push.rowsFor('phone-1').map(row => row.state)).toEqual(['failed', 'failed']);
  });

  it('rebuilds the provider JWT after 403 ExpiredProviderToken and then accepts', async () => {
    const key = writeTempApnsKey();
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop(), () => rmSync(key.dir, { recursive: true, force: true }));
    fake.handler = (_req, res) => {
      if (fake.requests.length === 1) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ reason: 'ExpiredProviderToken' }));
        return;
      }
      res.writeHead(200);
      res.end();
    };
    const push = attach(companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority }));
    push.register('phone-1', { provider: 'apns', token: DEVICE_TOKEN, environment: 'production' });
    gateway.publish('session-1', 'agent_complete', {});
    await push.flush();
    expect(push.rowsFor('phone-1')[0].state).toBe('sent');
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0].authorization).not.toBe(fake.requests[1].authorization);
  });

  it('fails the outbox row when the Auth Key is damaged instead of leaving it pending', async () => {
    const key = writeTempApnsPem('-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n');
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop(), () => rmSync(key.dir, { recursive: true, force: true }));
    const push = attach(companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority }));
    push.register('phone-1', { provider: 'apns', token: DEVICE_TOKEN, environment: 'production' });
    gateway.publish('session-1', 'agent_complete', {});
    await expect(push.flush()).resolves.toBeUndefined();
    expect(push.rowsFor('phone-1')[0].state).toBe('failed');
    expect(fake.requests).toHaveLength(0);
  });

  it('drops a malformed device token as dead without calling APNs', async () => {
    const key = writeTempApnsKey();
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop(), () => rmSync(key.dir, { recursive: true, force: true }));
    const push = attach(companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority }));
    push.register('phone-1', {
      provider: 'apns',
      token: `${'a'.repeat(32)}/${'b'.repeat(31)}`,
      environment: 'production',
    });
    gateway.publish('session-1', 'agent_complete', {});
    await push.flush();
    expect(push.rowsFor('phone-1')[0].state).toBe('failed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_push_registrations').get()).toEqual({ n: 0 });
    expect(fake.requests).toHaveLength(0);
  });

  it('keeps CHANNEL_MISSING:apns_auth_key when any APNs env is absent', async () => {
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop());
    const transport = companionApnsOutboxTransport({
      NEO_APNS_KEY_PATH: '/tmp/not-a-real-key.p8',
      NEO_APNS_KEY_ID: KEY_ID,
      NEO_APNS_TEAM_ID: TEAM_ID,
      NEO_APNS_BUNDLE_ID: BUNDLE_ID,
    });
    expect(transport).toEqual({ apnsKeyPath: null });
    const push = attach(transport);
    push.register('phone-1', { provider: 'apns', token: DEVICE_TOKEN, environment: 'production' });
    gateway.publish('session-1', 'agent_complete', {});
    await push.flush();
    expect(push.rowsFor('phone-1')[0].state).toBe('failed');
    expect(fake.requests).toHaveLength(0);
  });
});
