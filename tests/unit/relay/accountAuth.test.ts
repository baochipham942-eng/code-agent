import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupabaseJwtVerifier } from '../../../packages/relay/src/accountAuth';

const SUPABASE = 'https://proj.supabase.co';
const ISSUER = `${SUPABASE}/auth/v1`;
const NOW = 1_800_000_000_000;

function makeKey(kid: string): { kid: string; privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } };
}

function jwt(key: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc({ alg: 'ES256', typ: 'JWT', kid: key.kid, ...header });
  const body = enc({
    iss: ISSUER, aud: 'authenticated', role: 'authenticated', sub: 'user-0001',
    exp: Math.floor(NOW / 1000) + 3600, ...claims,
  });
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${signature.toString('base64url')}`;
}

function jwksFetch(state: { keys: Array<Record<string, unknown>>; fail?: boolean; calls: number }): typeof fetch {
  return (async (url: string | URL | Request) => {
    state.calls += 1;
    expect(String(url)).toBe(`${ISSUER}/.well-known/jwks.json`);
    if (state.fail) throw new Error('ECONNRESET');
    return new Response(JSON.stringify({ keys: state.keys }), { status: 200 });
  }) as typeof fetch;
}

const dirs: string[] = [];
function cacheFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-jwks-'));
  dirs.push(dir);
  return join(dir, 'jwks.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SupabaseJwtVerifier', () => {
  it('accepts a valid ES256 access token and returns sub', async () => {
    const key = makeKey('k1');
    const verifier = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE, fetch: jwksFetch({ keys: [key.jwk], calls: 0 }), now: () => NOW });
    await verifier.refresh();
    expect(verifier.verify(jwt(key))).toBe('user-0001');
    expect(verifier.stats).toMatchObject({ keys: 1, source: 'network', fetchedAt: NOW });
  });

  it('rejects wrong signature, expired, wrong issuer/audience/role, non-ES256 and malformed tokens', async () => {
    const key = makeKey('k1');
    const imposter = makeKey('k1');
    const verifier = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE, fetch: jwksFetch({ keys: [key.jwk], calls: 0 }), now: () => NOW });
    await verifier.refresh();
    expect(verifier.verify(jwt(imposter))).toBeNull();
    expect(verifier.verify(jwt(key, { exp: Math.floor(NOW / 1000) - 61 }))).toBeNull();
    expect(verifier.verify(jwt(key, { exp: Math.floor(NOW / 1000) - 30 }))).toBe('user-0001'); // 60s 时钟偏差内
    expect(verifier.verify(jwt(key, { iss: 'https://other.supabase.co/auth/v1' }))).toBeNull();
    expect(verifier.verify(jwt(key, { aud: 'anon' }))).toBeNull();
    expect(verifier.verify(jwt(key, { aud: ['x', 'authenticated'] }))).toBe('user-0001');
    expect(verifier.verify(jwt(key, { nbf: Math.floor(NOW / 1000) + 120 }))).toBeNull();
    expect(verifier.verify(jwt(key, { nbf: Math.floor(NOW / 1000) + 30 }))).toBe('user-0001');
    expect(verifier.verify(jwt(key, { role: 'anon' }))).toBeNull();
    expect(verifier.verify(jwt(key, { role: 'service_role' }))).toBeNull();
    expect(verifier.verify(jwt(key, { sub: '' }))).toBeNull();
    expect(verifier.verify(jwt(key, {}, { alg: 'HS256' }))).toBeNull();
    expect(verifier.verify('not-a-jwt')).toBeNull();
    expect(verifier.verify('a.b.c')).toBeNull();
    // 篡改 payload，签名不再覆盖
    const [head, , sig] = jwt(key).split('.');
    const forged = Buffer.from(JSON.stringify({ iss: ISSUER, aud: 'authenticated', role: 'authenticated', sub: 'attacker', exp: 9_999_999_999 })).toString('base64url');
    expect(verifier.verify(`${head}.${forged}.${sig}`)).toBeNull();
  });

  it('verifies from the disk cache when Supabase is unreachable at startup', async () => {
    const key = makeKey('k1');
    const file = cacheFile();
    const online = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE, cacheFile: file, fetch: jwksFetch({ keys: [key.jwk], calls: 0 }), now: () => NOW });
    await online.refresh();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ fetchedAt: NOW, keys: [{ kid: 'k1' }] });

    const offline = { keys: [], fail: true, calls: 0 };
    const restarted = new SupabaseJwtVerifier({ supabaseUrl: SUPABASE, cacheFile: file, fetch: jwksFetch(offline), now: () => NOW + 3_600_000 });
    restarted.start();
    // start 不等网络：落盘公钥同步可用
    expect(restarted.verify(jwt(key))).toBe('user-0001');
    expect(restarted.stats.source).toBe('disk');
    await restarted.refresh();
    restarted.stop();
    expect(offline.calls).toBeGreaterThan(0);
    // 网络失败保留原有公钥
    expect(restarted.verify(jwt(key))).toBe('user-0001');
    expect(readFileSync(file, 'utf8')).toContain('"k1"');
  });

  it('rejects every token once the cached keys are older than maxStaleMs', async () => {
    const key = makeKey('k1');
    let now = NOW;
    const verifier = new SupabaseJwtVerifier({
      supabaseUrl: SUPABASE, fetch: jwksFetch({ keys: [key.jwk], calls: 0 }), now: () => now, maxStaleMs: 1_000,
    });
    await verifier.refresh();
    now = NOW + 1_000;
    expect(verifier.verify(jwt(key))).toBe('user-0001');
    now = NOW + 1_001;
    expect(verifier.verify(jwt(key))).toBeNull();
  });

  it('with no keys at all rejects instead of throwing, and logs that once, not per connection', () => {
    const warns: string[] = [];
    const verifier = new SupabaseJwtVerifier({
      supabaseUrl: SUPABASE, fetch: jwksFetch({ keys: [], fail: true, calls: 0 }), now: () => NOW,
      logger: { info: () => {}, warn: event => warns.push(event) },
    });
    expect(verifier.verify(jwt(makeKey('k1')))).toBeNull();
    expect(verifier.verify(jwt(makeKey('k1')))).toBeNull();
    expect(warns).toEqual(['jwks_unavailable']);
    expect(verifier.stats).toEqual({ keys: 0, fetchedAt: null, source: 'none' });
  });

  it('an unknown kid is rejected now, triggers one background refresh, and passes after rotation', async () => {
    const current = makeKey('k1');
    const rotated = makeKey('k2');
    const state = { keys: [current.jwk], calls: 0 };
    let now = NOW;
    const verifier = new SupabaseJwtVerifier({
      supabaseUrl: SUPABASE, fetch: jwksFetch(state), now: () => now, unknownKidCooldownMs: 60_000,
    });
    await verifier.refresh();
    expect(state.calls).toBe(1);
    state.keys = [current.jwk, rotated.jwk];
    expect(verifier.verify(jwt(rotated))).toBeNull();
    expect(verifier.verify(jwt(rotated))).toBeNull();
    await verifier.refresh(); // 合并进行中的那次后台刷新，不额外发请求
    expect(state.calls).toBe(2);
    expect(verifier.verify(jwt(rotated))).toBe('user-0001');
    // 冷却期内伪造 kid 不再触发请求
    expect(verifier.verify(jwt(makeKey('forged')))).toBeNull();
    now += 59_999;
    expect(verifier.verify(jwt(makeKey('forged2')))).toBeNull();
    await verifier.refresh();
    expect(state.calls).toBe(3); // 只有显式那次
  });

  it('ignores non-P-256 or non-signing keys in the JWKS', async () => {
    const key = makeKey('k1');
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const verifier = new SupabaseJwtVerifier({
      supabaseUrl: SUPABASE, now: () => NOW,
      fetch: jwksFetch({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'rsa' }, { ...key.jwk, use: 'enc' }], calls: 0 }),
    });
    await verifier.refresh();
    expect(verifier.stats.keys).toBe(0);
    expect(verifier.verify(jwt(key))).toBeNull();
  });
});
