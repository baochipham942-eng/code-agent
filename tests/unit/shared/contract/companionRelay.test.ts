import { describe, expect, it } from 'vitest';
import { COMPANION_LIMITS as L } from '../../../../src/shared/constants/companion';
import {
  companionRelayFrameExpired,
  parseCompanionRelayFrame,
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
  });

  it('parses the committed config template shape as disabled', () => {
    expect(resolveCompanionRelayConfig({
      v: 1, enabled: false, url: 'wss://relay.example.invalid/companion',
      credentialRef: 'companion-relay', reconnectBackoffMs: [...L.relayReconnectBackoffMs],
    })).toBeNull();
  });
});
