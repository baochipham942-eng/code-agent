import { describe, expect, it } from 'vitest';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';
import {
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
  parseCompanionRelayRoute,
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
});
