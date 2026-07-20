import { describe, expect, it } from 'vitest';
import { resolveBrowserActionEngine } from '../../../../src/host/tools/vision/browserEngineRouter';

describe('browser engine routing for relay (ADR-041 M3)', () => {
  it('auto defaults to managed even when relay is connected and tabs are attached', () => {
    const decision = resolveBrowserActionEngine({
      requestedEngine: 'auto',
      targetUrl: 'https://github.com/settings',
      relay: { status: 'connected', attachedTabCount: 2, enabled: true },
      relayLeaseReady: true,
    });
    expect(decision.selectedEngine).toBe('managed');
    expect(decision.reason).toBe('auto_default_managed');
  });

  it('keeps managed for localhost even when relay is ready', () => {
    const decision = resolveBrowserActionEngine({
      requestedEngine: 'auto',
      targetUrl: 'http://127.0.0.1:5173',
      relay: { status: 'connected', attachedTabCount: 1, enabled: true },
      relayLeaseReady: true,
    });
    expect(decision.selectedEngine).toBe('managed');
  });
});
