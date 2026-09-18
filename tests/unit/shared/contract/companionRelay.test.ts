import { describe, expect, it } from 'vitest';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';
import {
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
  parseCompanionRelayRoute,
  parseCompanionRelayRoutes,
  resolveCompanionRelayConfig,
} from '../../../../src/shared/contract/companionRelay';

const envelope = {
  routeToken: 'route-token-aaaaaa',
  deviceRef: 'phone-1',
  seq: 0,
  ttlMs: L.relayRouteTokenTtlMs,
  issuedAt: 1_700_000_000_000,
};

describe('companion relay contract', () => {
  it('parses a versioned envelope plus opaque ciphertext', () => {
    const frame = parseCompanionRelayFrame({
      v: 1,
      kind: 'forward',
      envelope: { ...envelope, idempotencyKey: 'once' },
      ciphertext: 'deadbeef',
    });
    expect(frame.kind).toBe('forward');
    expect(frame.envelope.routeToken).toBe(envelope.routeToken);
    expect(frame.ciphertext).toBe('deadbeef');
  });

  it('rejects a reserved/unknown version', () => {
    expect(() => parseCompanionRelayFrame({
      v: 2, kind: 'forward', envelope, ciphertext: 'aa',
    })).toThrow('COMPANION_RELAY_INVALID_FRAME');
  });

  it('rejects plaintext command fields beside the ciphertext', () => {
    expect(() => parseCompanionRelayFrame({
      v: 1, kind: 'forward', envelope, ciphertext: 'aa',
      command: { action: 'message.send', payload: { text: 'secret' } },
    })).toThrow('COMPANION_RELAY_INVALID_FRAME');
  });

  it('rejects empty ciphertext on handshake/forward and payload on control', () => {
    expect(() => parseCompanionRelayFrame({ v: 1, kind: 'forward', envelope, ciphertext: '' }))
      .toThrow('COMPANION_RELAY_INVALID_FRAME');
    expect(() => parseCompanionRelayFrame({ v: 1, kind: 'register', role: 'host', envelope, ciphertext: 'aa' }))
      .toThrow('COMPANION_RELAY_INVALID_FRAME');
  });

  // N-COMPANION-RELAY-ROUTE-TAKEOVER：register 的 optional instanceId（Host 内存启动 nonce，
  // base64url——与 routeToken 同字符集）。optional 是为了接住旧 Host 与 device 角色（手机不发它）；
  // strict 不松，字段外的私货照拒。
  it('parses register with and without an instanceId, rejecting bad encodings', () => {
    const register = (instanceId?: string) => parseCompanionRelayFrame({
      v: 1, kind: 'register', role: 'host', ...(instanceId ? { instanceId } : {}),
      envelope, ciphertext: '',
    });
    expect(register('alpha-instance-00000001').kind).toBe('register');
    expect(register().kind).toBe('register');
    expect(() => register('short')).toThrow('COMPANION_RELAY_INVALID_FRAME');
    expect(() => register('bad charset!!')).toThrow('COMPANION_RELAY_INVALID_FRAME');
    expect(parseCompanionRelayFrame({
      v: 1, kind: 'register', role: 'device', instanceId: 'alpha-instance-00000001', envelope, ciphertext: '',
    }).kind).toBe('register');
  });

  it('expires a frame by envelope TTL', () => {
    const frame = parseCompanionRelayFrame({ v: 1, kind: 'heartbeat', envelope, ciphertext: '' });
    expect(companionRelayFrameExpired(frame, envelope.issuedAt + envelope.ttlMs - 1)).toBe(false);
    expect(companionRelayFrameExpired(frame, envelope.issuedAt + envelope.ttlMs)).toBe(true);
  });

  it('resolves config only when enabled with url and credentialRef', () => {
    expect(resolveCompanionRelayConfig(undefined)).toBeNull();
    expect(resolveCompanionRelayConfig({ v: 1, enabled: false, url: 'wss://relay.example.invalid/companion', credentialRef: 'companion-relay' })).toBeNull();
    expect(resolveCompanionRelayConfig({ v: 1, enabled: true })).toBeNull();
    expect(resolveCompanionRelayConfig({
      v: 1, enabled: true, url: 'wss://relay.example.invalid/companion', credentialRef: 'companion-relay',
    })).toMatchObject({ url: 'wss://relay.example.invalid/companion', credentialRef: 'companion-relay' });
  });

  it('accepts loopback ws and rejects cleartext non-loopback', () => {
    expect(resolveCompanionRelayConfig({
      v: 1, enabled: true, url: 'ws://127.0.0.1:9/', credentialRef: 'companion-relay',
    })?.url).toContain('127.0.0.1');
    expect(() => resolveCompanionRelayConfig({
      v: 1, enabled: true, url: 'ws://relay.example.invalid/companion', credentialRef: 'companion-relay',
    })).toThrow('COMPANION_RELAY_INSECURE_URL');
    expect(() => resolveCompanionRelayConfig({
      v: 1, enabled: true, url: 'wss://user:pass@relay.example.invalid/companion', credentialRef: 'companion-relay',
    })).toThrow('COMPANION_RELAY_INVALID_URL');
    expect(() => resolveCompanionRelayConfig({
      v: 1, enabled: true, url: 'wss://relay.example.invalid/companion?token=secret', credentialRef: 'companion-relay',
    })).toThrow('COMPANION_RELAY_INVALID_URL');
  });

  it('parses the committed config template shape as disabled', () => {
    expect(resolveCompanionRelayConfig({
      v: 1, enabled: false, url: 'wss://relay.example.invalid/companion',
      credentialRef: 'companion-relay', reconnectBackoffMs: [...L.relayReconnectBackoffMs],
    })).toBeNull();
  });

  // N-MOBILE-RELAY-PHONE：手机缓存的 relay 路由与 config 同一条 URL 纪律（凭据不进 URL，
  // 非环回必须 wss），routeToken/credential 有最小长度——坏一条路由丢一条，不连累配对盘。
  it('parses a phone-cached route and enforces the same URL discipline', () => {
    expect(parseCompanionRelayRoute({
      v: 1, url: 'wss://relay.example.invalid:8443', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential',
    })).toMatchObject({ v: 1, url: 'wss://relay.example.invalid:8443/', routeToken: 'route-token-aaaaaa' });
    expect(() => parseCompanionRelayRoute({
      v: 1, url: 'ws://relay.example.invalid:8443', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential',
    })).toThrow('COMPANION_RELAY_INSECURE_URL');
    expect(() => parseCompanionRelayRoute({
      v: 1, url: 'wss://relay.example.invalid:8443?token=secret', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential',
    })).toThrow('COMPANION_RELAY_INVALID_URL');
    expect(() => parseCompanionRelayRoute({
      v: 1, url: 'wss://relay.example.invalid:8443', routeToken: 'route-token-aaaaaa', credential: 'short',
    })).toThrow('COMPANION_RELAY_INVALID_ROUTE');
    expect(() => parseCompanionRelayRoute({
      v: 2, url: 'wss://relay.example.invalid:8443', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential',
    })).toThrow('COMPANION_RELAY_INVALID_ROUTE');
    // 环回 ws 给本地 fake relay（集成测试链路）。
    expect(parseCompanionRelayRoute({
      v: 1, url: 'ws://127.0.0.1:8791', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential',
    }).url).toContain('127.0.0.1');
  });

  // N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE：relay.routes 的双路由载荷。既有 route 契约一个字
  // 不改（legacy 原样复用）；account 是不带凭据的路由引用；两条都可选，缺条目不得作废另一条。
  it('parses dual routes: account ref without credential, legacy route unchanged', () => {
    const routes = parseCompanionRelayRoutes({
      v: 1,
      account: { v: 1, url: 'wss://relay.example.invalid:8443', routeToken: 'account-token-aaaaaa' },
      legacy: { v: 1, url: 'wss://relay.example.invalid:8443', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' },
    });
    expect(routes).toEqual({
      v: 1,
      account: { v: 1, url: 'wss://relay.example.invalid:8443/', routeToken: 'account-token-aaaaaa' },
      legacy: { v: 1, url: 'wss://relay.example.invalid:8443/', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' },
    });
    // 缺哪条都行：只有旧通道 / 只有账号通道 / 两条都没有，都是合法载荷。
    expect(parseCompanionRelayRoutes({ v: 1, legacy: { v: 1, url: 'wss://relay.example.invalid:8443', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' } }).account).toBeUndefined();
    expect(parseCompanionRelayRoutes({ v: 1 }).legacy).toBeUndefined();
    // 账号引用带凭据＝形状不对：凭据不随路由下发。
    expect(() => parseCompanionRelayRoutes({
      v: 1, account: { v: 1, url: 'wss://relay.example.invalid:8443', routeToken: 'account-token-aaaaaa', credential: 'relay-shared-credential' },
    })).toThrow('COMPANION_RELAY_INVALID_ROUTES');
    // URL 纪律与既有契约同源：明文非环回拒。
    expect(() => parseCompanionRelayRoutes({
      v: 1, account: { v: 1, url: 'ws://relay.example.invalid:8443', routeToken: 'account-token-aaaaaa' },
    })).toThrow('COMPANION_RELAY_INSECURE_URL');
    expect(() => parseCompanionRelayRoutes({ v: 2 })).toThrow('COMPANION_RELAY_INVALID_ROUTES');
    expect(() => parseCompanionRelayRoutes({ v: 1, extra: true })).toThrow('COMPANION_RELAY_INVALID_ROUTES');
  });
});
