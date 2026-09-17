import { describe, expect, it } from 'vitest';
import { createIdentity } from '../../../../../src/shared/companion/noiseChannel';
import { deriveCompanionRelayRouteToken } from '../../../../../src/host/services/companion/companionRelayRouteToken';
import { parseCompanionRelayRoute } from '../../../../../src/shared/contract/companionRelay';

/**
 * N-COMPANION-RELAY-PHONE-AUTH：routeToken 从随机铸造改成确定性派生（Host 重启不换
 * token）。这里钉住派生的四维唯一性与输出契约；「重启不变/epoch 变化」的端到端形态在
 * tests/integration/companionRelayPhoneSubprotocol.test.ts。
 */
describe('deriveCompanionRelayRouteToken', () => {
  const identity = createIdentity();

  it('is deterministic for the same key, device, epoch and namespace', () => {
    const first = deriveCompanionRelayRouteToken(identity.secretKey, 'phone-1', 3);
    const second = deriveCompanionRelayRouteToken(identity.secretKey.slice(), 'phone-1', 3);
    expect(second).toBe(first);
  });

  it('differs per deviceId, scopeEpoch and namespace', () => {
    const base = deriveCompanionRelayRouteToken(identity.secretKey, 'phone-1', 3);
    expect(deriveCompanionRelayRouteToken(identity.secretKey, 'phone-2', 3)).not.toBe(base);
    expect(deriveCompanionRelayRouteToken(identity.secretKey, 'phone-1', 4)).not.toBe(base);
    expect(deriveCompanionRelayRouteToken(identity.secretKey, 'phone-1', 3, 'account-1')).not.toBe(base);
  });

  it('differs per host identity key', () => {
    const base = deriveCompanionRelayRouteToken(identity.secretKey, 'phone-1', 3);
    expect(deriveCompanionRelayRouteToken(createIdentity().secretKey, 'phone-1', 3)).not.toBe(base);
  });

  it('produces tokens that satisfy the relay route contract schema', () => {
    const token = deriveCompanionRelayRouteToken(identity.secretKey, 'phone-1', 3);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const route = parseCompanionRelayRoute({
      v: 1, url: 'wss://relay.example.invalid:8443', routeToken: token, credential: 'relay-shared-credential',
    });
    expect(route.routeToken).toBe(token);
  });
});
