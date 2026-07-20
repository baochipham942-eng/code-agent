import { describe, expect, it } from 'vitest';
import { resolveBrowserActionEngine } from '../../../../src/host/tools/vision/browserEngineRouter';

describe('browserEngineRouter (ADR-041)', () => {
  it('honors explicit managed and never silently switches when unavailable', () => {
    const decision = resolveBrowserActionEngine({
      requestedEngine: 'managed',
      managedAvailable: false,
    });
    expect(decision.selectedEngine).toBe('managed');
    expect(decision.recovery?.code).toBe('managed_unavailable');
    expect(decision.recovery?.selectedEngine).toBeNull();
  });

  it('honors explicit relay only when connected with a valid owner lease', () => {
    const missing = resolveBrowserActionEngine({
      requestedEngine: 'relay',
      relay: { status: 'listening', attachedTabCount: 0, enabled: true },
      relayLeaseReady: true,
    });
    expect(missing.recovery?.code).toBe('relay_not_connected');

    const noLease = resolveBrowserActionEngine({
      requestedEngine: 'relay',
      relay: { status: 'connected', attachedTabCount: 99, enabled: true },
    });
    expect(noLease.selectedEngine).toBe('relay');
    expect(noLease.recovery?.code).toBe('BROWSER_TAB_BORROW_REQUIRED');
    expect(noLease.recovery?.selectedEngine).toBeNull();

    const ready = resolveBrowserActionEngine({
      requestedEngine: 'relay',
      relay: { status: 'connected', attachedTabCount: 0, enabled: true },
      relayLeaseReady: true,
    });
    expect(ready.selectedEngine).toBe('relay');
    expect(ready.recovery).toBeUndefined();
  });

  it('auto prefers managed for localhost and relay for login reuse with a valid lease', () => {
    const local = resolveBrowserActionEngine({
      requestedEngine: 'auto',
      targetUrl: 'http://localhost:3000/app',
      relay: { status: 'connected', attachedTabCount: 1, enabled: true },
    });
    expect(local.selectedEngine).toBe('managed');
    expect(local.reason).toBe('auto_local_url');

    const login = resolveBrowserActionEngine({
      requestedEngine: 'auto',
      intent: 'login_reuse',
      targetUrl: 'https://github.com',
      relay: { status: 'connected', attachedTabCount: 1, enabled: true },
      relayLeaseReady: true,
    });
    expect(login.selectedEngine).toBe('relay');
    expect(login.reason).toBe('auto_login_reuse_relay');
  });

  it('auto defaults to managed and reports connection recovery for login without relay', () => {
    const decision = resolveBrowserActionEngine({
      requestedEngine: 'auto',
      intent: 'login_reuse',
      targetUrl: 'https://app.example.com',
      relay: { status: 'stopped', attachedTabCount: 0, enabled: true },
    });
    expect(decision.selectedEngine).toBe('managed');
    expect(decision.recovery?.code).toBe('relay_not_connected');
    expect(decision.recovery?.recommendedAction).toContain('relay');
  });

  it('never treats attached tab count as lease authorization for login reuse', () => {
    const decision = resolveBrowserActionEngine({
      requestedEngine: 'auto',
      intent: 'login_reuse',
      targetUrl: 'https://app.example.com',
      relay: { status: 'connected', attachedTabCount: 42, enabled: true },
    });

    expect(decision.selectedEngine).toBe('managed');
    expect(decision.reason).toBe('auto_login_reuse_managed_recovery');
    expect(decision.recovery?.code).toBe('BROWSER_TAB_BORROW_REQUIRED');
    expect(decision.recovery?.selectedEngine).toBe('managed');
    expect(decision.recovery?.availableEngines).not.toContain('relay');
  });
});
