import { generateKeyPairSync, verify } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { companionApnsOutboxTransport } from '../../../src/host/services/companion/companionApnsProvider';
import { COMPANION_APNS } from '../../../src/shared/constants/companion';
import { listenFakeApns, writeTempApnsKey, writeTempApnsPem } from './fakeApnsServer';

const KEY_ID = 'TESTKEYID1';
const TEAM_ID = 'TESTTEAM01';
const BUNDLE_ID = 'dev.neo.companion.test';
const DEVICE_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function envFor(keyPath: string, environment: 'production' | 'sandbox' = 'production') {
  return {
    NEO_APNS_KEY_PATH: keyPath,
    NEO_APNS_KEY_ID: KEY_ID,
    NEO_APNS_TEAM_ID: TEAM_ID,
    NEO_APNS_BUNDLE_ID: BUNDLE_ID,
    NEO_APNS_ENV: environment,
  };
}

const payload = { titleKey: 'task_complete' as const, kind: 'agent_complete' as const, routeToken: 'route-token-test-aaaa' };

describe('companion APNs provider', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()?.();
  });

  it('fails closed when any APNs env is missing or the environment is not production|sandbox', () => {
    const complete = envFor('/tmp/not-a-real-key.p8');
    for (const key of Object.keys(complete) as Array<keyof typeof complete>) {
      const env = { ...complete, [key]: '' };
      expect(companionApnsOutboxTransport(env), key).toEqual({ apnsKeyPath: null });
    }
    expect(companionApnsOutboxTransport({ ...complete, NEO_APNS_ENV: 'prod' })).toEqual({ apnsKeyPath: null });
    expect(companionApnsOutboxTransport({ ...complete, NEO_APNS_KEY_ID: '  ' })).toEqual({ apnsKeyPath: null });
  });

  it('selects the Apple authority from NEO_APNS_ENV', () => {
    const production = companionApnsOutboxTransport(envFor('/tmp/not-a-real-key.p8', 'production'));
    const sandbox = companionApnsOutboxTransport(envFor('/tmp/not-a-real-key.p8', 'sandbox'));
    expect(production.authority).toBe(COMPANION_APNS.productionAuthority);
    expect(sandbox.authority).toBe(COMPANION_APNS.sandboxAuthority);
    expect(production.apnsKeyPath).toBe('/tmp/not-a-real-key.p8');
    expect(production.send).toEqual(expect.any(Function));
  });

  it('routes each send to the request environment, not the host NEO_APNS_ENV default', async () => {
    const key = writeTempApnsKey();
    const productionFake = await listenFakeApns();
    const sandboxFake = await listenFakeApns();
    cleanup.push(
      () => productionFake.stop(),
      () => sandboxFake.stop(),
      () => rmSync(key.dir, { recursive: true, force: true }),
    );
    const transport = companionApnsOutboxTransport(envFor(key.keyPath, 'production'), {
      authority: environment => environment === 'sandbox' ? sandboxFake.authority : productionFake.authority,
    });
    expect(transport.authority).toBe(COMPANION_APNS.productionAuthority);
    expect(await transport.send!({ provider: 'apns', environment: 'sandbox', token: DEVICE_TOKEN, payload }))
      .toEqual({ accepted: true });
    expect(await transport.send!({ provider: 'apns', environment: 'production', token: DEVICE_TOKEN, payload }))
      .toEqual({ accepted: true });
    expect(sandboxFake.requests).toHaveLength(1);
    expect(productionFake.requests).toHaveLength(1);
    expect(sandboxFake.requests[0].path).toBe(`${COMPANION_APNS.pathPrefix}${DEVICE_TOKEN}`);
    expect(productionFake.requests[0].path).toBe(`${COMPANION_APNS.pathPrefix}${DEVICE_TOKEN}`);
  });

  it('signs an ES256 JWT whose header, payload, and signature verify', async () => {
    const key = writeTempApnsKey();
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop(), () => rmSync(key.dir, { recursive: true, force: true }));
    const transport = companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority, now: () => 1_700_000_000_000 });
    const result = await transport.send!({
      provider: 'apns', environment: 'production', token: DEVICE_TOKEN, payload,
    });
    expect(result).toEqual({ accepted: true });
    const authorization = fake.requests[0]?.authorization ?? '';
    expect(authorization.startsWith('bearer ')).toBe(true);
    const jwt = authorization.slice('bearer '.length);
    const [headerPart, payloadPart, signaturePart] = jwt.split('.');
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as { alg: string; kid: string };
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as { iss: string; iat: number };
    expect(header).toEqual({ alg: 'ES256', kid: KEY_ID });
    expect(claims).toEqual({ iss: TEAM_ID, iat: 1_700_000_000 });
    expect(verify(
      'sha256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      { key: key.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signaturePart, 'base64url'),
    )).toBe(true);
    const other = writeTempApnsKey();
    cleanup.push(() => rmSync(other.dir, { recursive: true, force: true }));
    expect(verify(
      'sha256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      { key: other.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signaturePart, 'base64url'),
    )).toBe(false);
    expect(authorization).not.toContain('BEGIN PRIVATE KEY');
    expect(fake.requests[0]?.body).not.toContain('BEGIN PRIVATE KEY');
  });

  it('assembles the APNs body from the contract payload and alert envelope', async () => {
    const key = writeTempApnsKey();
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop(), () => rmSync(key.dir, { recursive: true, force: true }));
    const transport = companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority });
    await transport.send!({ provider: 'apns', environment: 'production', token: DEVICE_TOKEN, payload });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      path: `${COMPANION_APNS.pathPrefix}${DEVICE_TOKEN}`,
      topic: BUNDLE_ID,
      pushType: COMPANION_APNS.pushType,
    });
    expect(JSON.parse(fake.requests[0].body)).toEqual({
      aps: { alert: { 'loc-key': 'task_complete' } },
      titleKey: 'task_complete',
      kind: 'agent_complete',
      routeToken: 'route-token-test-aaaa',
    });
    expect(fake.requests[0].body).not.toContain(DEVICE_TOKEN);
    expect(fake.requests[0].authorization).not.toContain(DEVICE_TOKEN);
  });

  it('maps 410 Unregistered and 400 BadDeviceToken to NOT_REGISTERED', async () => {
    const key = writeTempApnsKey();
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop(), () => rmSync(key.dir, { recursive: true, force: true }));
    fake.handler = (_req, res) => {
      res.writeHead(410, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reason: 'Unregistered' }));
    };
    const transport = companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority });
    expect(await transport.send!({ provider: 'apns', environment: 'production', token: DEVICE_TOKEN, payload }))
      .toEqual({ accepted: false, code: 'NOT_REGISTERED' });
    fake.handler = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reason: 'BadDeviceToken' }));
    };
    expect(await transport.send!({ provider: 'apns', environment: 'production', token: DEVICE_TOKEN, payload }))
      .toEqual({ accepted: false, code: 'NOT_REGISTERED' });
  });

  it('rebuilds the JWT once after 403 ExpiredProviderToken', async () => {
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
    const transport = companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority, now: () => 1_700_000_000_000 });
    expect(await transport.send!({ provider: 'apns', environment: 'production', token: DEVICE_TOKEN, payload }))
      .toEqual({ accepted: true });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0].authorization).not.toBe(fake.requests[1].authorization);
    const firstIat = JSON.parse(Buffer.from(fake.requests[0].authorization.split('.')[1], 'base64url').toString('utf8')) as { iat: number };
    const secondIat = JSON.parse(Buffer.from(fake.requests[1].authorization.split('.')[1], 'base64url').toString('utf8')) as { iat: number };
    expect(secondIat.iat).toBe(firstIat.iat + 1);
  });

  it('maps a damaged or non-EC Auth Key to CHANNEL_MISSING without sending', async () => {
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop());
    const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      .export({ type: 'pkcs8', format: 'pem' }) as string;
    for (const pem of [
      '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
      rsaPem,
    ]) {
      const key = writeTempApnsPem(pem);
      cleanup.push(() => rmSync(key.dir, { recursive: true, force: true }));
      const transport = companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority });
      await expect(transport.send!({ provider: 'apns', environment: 'production', token: DEVICE_TOKEN, payload }))
        .resolves.toEqual({ accepted: false, code: 'CHANNEL_MISSING', missing: 'apns_auth_key' });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects a non-hex or wrong-length device token as NOT_REGISTERED without calling APNs', async () => {
    const key = writeTempApnsKey();
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop(), () => rmSync(key.dir, { recursive: true, force: true }));
    const transport = companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority });
    const malformed = [
      'z'.repeat(COMPANION_APNS.deviceTokenHexLength),
      DEVICE_TOKEN.slice(1),
      `${DEVICE_TOKEN}aa`,
      `${'a'.repeat(32)}/${'b'.repeat(31)}`,
      'device-token-aaaaaaaa',
    ];
    for (const token of malformed) {
      await expect(transport.send!({ provider: 'apns', environment: 'production', token, payload }))
        .resolves.toEqual({ accepted: false, code: 'NOT_REGISTERED' });
    }
    expect(fake.requests).toHaveLength(0);
    expect(await transport.send!({
      provider: 'apns', environment: 'production', token: DEVICE_TOKEN.toUpperCase(), payload,
    })).toEqual({ accepted: true });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].path).toBe(`${COMPANION_APNS.pathPrefix}${DEVICE_TOKEN.toUpperCase()}`);
  });

  it('returns a retryable result and honors Retry-After seconds', async () => {
    const key = writeTempApnsKey();
    const fake = await listenFakeApns();
    cleanup.push(() => fake.stop(), () => rmSync(key.dir, { recursive: true, force: true }));
    fake.handler = (_req, res) => {
      res.writeHead(429, { 'retry-after': '5', 'content-type': 'application/json' });
      res.end(JSON.stringify({ reason: 'TooManyRequests' }));
    };
    const transport = companionApnsOutboxTransport(envFor(key.keyPath), { authority: fake.authority });
    expect(await transport.send!({ provider: 'apns', environment: 'production', token: DEVICE_TOKEN, payload }))
      .toEqual({ accepted: false, code: 'PROVIDER_RETRY', retryAfterMs: 5_000 });
  });
});
