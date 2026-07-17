import { describe, expect, it } from 'vitest';
import { resolveBrowserActionEngine } from '../../../../src/host/tools/vision/browserEngineRouter';

describe('browser engine routing for relay (ADR-041 M3)', () => {
  it('auto routes to relay when attached and not local', () => {
    const decision = resolveBrowserActionEngine({
      requestedEngine: 'auto',
      targetUrl: 'https://github.com/settings',
      relay: { status: 'connected', attachedTabCount: 2, enabled: true },
    });
    expect(decision.selectedEngine).toBe('relay');
  });

  it('keeps managed for localhost even when relay is ready', () => {
    const decision = resolveBrowserActionEngine({
      requestedEngine: 'auto',
      targetUrl: 'http://127.0.0.1:5173',
      relay: { status: 'connected', attachedTabCount: 1, enabled: true },
    });
    expect(decision.selectedEngine).toBe('managed');
  });
});
