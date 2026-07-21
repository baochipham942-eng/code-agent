import { describe, expect, it } from 'vitest';
import { checkBrowserRelay } from '../../../src/host/diagnostics/checks/browserRelay';
import type { ManagedBrowserExternalBridgeState } from '../../../src/shared/contract/desktop';

function state(
  overrides: Partial<ManagedBrowserExternalBridgeState> = {},
): ManagedBrowserExternalBridgeState {
  return {
    enabled: true,
    status: 'stopped',
    requiresExplicitAuthorization: true,
    extensionPath: '/safe/browser-relay-extension',
    connectedTabCount: 0,
    attachedTabCount: 0,
    ...overrides,
  };
}

describe('Browser Relay doctor check', () => {
  it('reports a connected protocol-compatible relay without exposing pairing material', () => {
    const items = checkBrowserRelay(state({
      status: 'connected',
      connectedTabCount: 1,
      attachedTabCount: 2,
      tokenHint: 'abcd...wxyz',
    }), () => true);

    expect(items).toEqual([expect.objectContaining({
      category: 'provider_health',
      name: 'Browser Relay V2',
      status: 'pass',
      message: expect.stringContaining('protocol 2.2'),
    })]);
    expect(JSON.stringify(items)).not.toContain('abcd...wxyz');
  });

  it.each([
    ['stopped', 'warn'],
    ['listening', 'warn'],
    ['error', 'fail'],
    ['unsupported', 'fail'],
  ] as const)('maps %s to %s without trying to repair or bypass the relay', (status, expected) => {
    const items = checkBrowserRelay(state({
      status,
      lastError: 'authorization=relay-secret-canary protocol mismatch',
    }), () => false);

    expect(items[0]?.status).toBe(expected);
    expect(JSON.stringify(items)).not.toContain('relay-secret-canary');
  });
});
