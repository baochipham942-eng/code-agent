import { describe, expect, it } from 'vitest';
import {
  resolveBrowserActionEngine,
  type BrowserEngineRouteInput,
  type BrowserRelayRouteAuthorization,
} from '../../../../src/host/tools/vision/browserEngineRouter';

const NOW = 10_000;
const owner = {
  conversationId: 'conversation-1',
  runId: 'run-1',
  agentId: 'agent-1',
};
const target = {
  browserInstanceId: 'browser:relay-1',
  windowRef: 'window:agent-1',
  tabRef: 'tab:opaque-1',
  origin: 'https://github.com',
  documentRevision: 'document:1',
} as const;

function authorization(
  overrides: Partial<BrowserRelayRouteAuthorization> = {},
): BrowserRelayRouteAuthorization {
  return {
    owner,
    live: true,
    leaseState: 'leased',
    expiresAt: NOW + 30_000,
    actionScopes: ['get_content', 'click', 'navigate', 'lease:return'],
    domainScopes: ['origin:https://github.com'],
    target,
    ...overrides,
  };
}

function relayInput(overrides: Partial<BrowserEngineRouteInput> = {}): BrowserEngineRouteInput {
  return {
    requestedEngine: 'relay',
    action: 'get_content',
    targetUrl: 'https://github.com/settings',
    target: { ...target, identityStatus: 'verified' },
    owner,
    relay: { status: 'connected', attachedTabCount: 99, enabled: true },
    relayAuthorization: authorization(),
    managedAvailable: true,
    nowMs: NOW,
    ...overrides,
  };
}

describe('browserEngineRouter (ADR-041 / Surface Execution V1)', () => {
  it('honors explicit managed and never silently switches when unavailable', () => {
    const decision = resolveBrowserActionEngine({
      requestedEngine: 'managed',
      action: 'get_content',
      managedAvailable: false,
    });
    expect(decision.selectedEngine).toBe('managed');
    expect(decision.recovery?.code).toBe('managed_unavailable');
    expect(decision.recovery?.selectedEngine).toBeNull();
  });

  it('requires provider readiness plus a complete owner-scoped lease', () => {
    const disconnected = resolveBrowserActionEngine(relayInput({
      relay: { status: 'listening', attachedTabCount: 0, enabled: true },
    }));
    expect(disconnected.recovery?.code).toBe('relay_not_connected');

    const disabled = resolveBrowserActionEngine(relayInput({
      relay: { status: 'connected', attachedTabCount: 1, enabled: false },
    }));
    expect(disabled.recovery?.code).toBe('relay_not_connected');

    const ready = resolveBrowserActionEngine(relayInput());
    expect(ready).toMatchObject({ selectedEngine: 'relay', reason: 'explicit_relay' });
    expect(ready.recovery).toBeUndefined();
  });

  it('never upgrades attached-tab state or the legacy ready boolean into authority', () => {
    const decision = resolveBrowserActionEngine({
      requestedEngine: 'auto',
      action: 'get_content',
      intent: 'login_reuse',
      targetUrl: 'https://github.com/settings',
      owner,
      relay: { status: 'connected', attachedTabCount: 42, enabled: true },
      relayLeaseReady: true,
      managedAvailable: true,
      nowMs: NOW,
    });
    expect(decision.selectedEngine).toBe('managed');
    expect(decision.recovery?.code).toBe('BROWSER_TAB_BORROW_REQUIRED');
    expect(decision.recovery?.availableEngines).not.toContain('relay');
  });

  it('checks owner, live state, and expiry before Relay can be selected', () => {
    const wrongOwner = resolveBrowserActionEngine(relayInput({
      owner: { ...owner, agentId: 'agent-attacker' },
    }));
    expect(wrongOwner.recovery?.code).toBe('SURFACE_TARGET_NOT_OWNED');

    const expired = resolveBrowserActionEngine(relayInput({
      relayAuthorization: authorization({ expiresAt: NOW }),
    }));
    expect(expired.recovery?.code).toBe('BROWSER_TAB_BORROW_REQUIRED');

    const orphaned = resolveBrowserActionEngine(relayInput({
      relayAuthorization: authorization({ live: false, leaseState: 'orphaned' }),
    }));
    expect(orphaned.recovery?.code).toBe('BROWSER_TAB_BORROW_REQUIRED');
  });

  it('checks action capability and the approved action scope', () => {
    const unsupported = resolveBrowserActionEngine(relayInput({ action: 'wait_for_download' }));
    expect(unsupported.recovery).toMatchObject({
      code: 'SURFACE_CAPABILITY_UNSUPPORTED',
      selectedEngine: null,
    });

    const unapproved = resolveBrowserActionEngine(relayInput({
      action: 'click',
      relayAuthorization: authorization({ actionScopes: ['get_content'] }),
    }));
    expect(unapproved.recovery).toMatchObject({
      code: 'SURFACE_APPROVAL_INVALID',
      recommendedAction: 'request_relay_action_scope',
    });
  });

  it('checks domain and exact leased target identity', () => {
    const wrongDomain = resolveBrowserActionEngine(relayInput({
      action: 'navigate',
      targetUrl: 'https://evil.invalid/phish',
    }));
    expect(wrongDomain.recovery).toMatchObject({
      code: 'SURFACE_APPROVAL_INVALID',
      recommendedAction: 'request_relay_domain_scope',
    });

    const wrongTab = resolveBrowserActionEngine(relayInput({
      target: { ...target, tabRef: 'tab:other', identityStatus: 'mismatch' },
    }));
    expect(wrongTab.recovery?.code).toBe('SURFACE_TARGET_NOT_OWNED');

    const staleDocument = resolveBrowserActionEngine(relayInput({
      target: { ...target, documentRevision: 'document:old', identityStatus: 'stale' },
    }));
    expect(staleDocument.recovery?.code).toBe('SURFACE_STATE_STALE');

    const missingTarget = resolveBrowserActionEngine(relayInput({ target: null }));
    expect(missingTarget.recovery?.code).toBe('SURFACE_TARGET_AMBIGUOUS');
  });

  it('keeps isolation, preview, automation, CI, and localhost on Managed', () => {
    const cases: Array<[Partial<BrowserEngineRouteInput>, string]> = [
      [{ requireIsolatedProfile: true }, 'auto_isolated_profile'],
      [{ intent: 'preview' }, 'auto_automation_or_preview'],
      [{ intent: 'automation' }, 'auto_automation_or_preview'],
      [{ isCiOrTest: true }, 'auto_ci_or_test'],
      [{ targetUrl: 'http://localhost:3000/app' }, 'auto_local_url'],
    ];
    for (const [overrides, reason] of cases) {
      const decision = resolveBrowserActionEngine(relayInput({
        requestedEngine: 'auto',
        ...overrides,
      }));
      expect(decision).toMatchObject({ selectedEngine: 'managed', reason });
    }
  });

  it('uses Relay for login reuse only when every routing fence is satisfied', () => {
    const ready = resolveBrowserActionEngine(relayInput({
      requestedEngine: 'auto',
      intent: 'login_reuse',
    }));
    expect(ready).toMatchObject({
      selectedEngine: 'relay',
      reason: 'auto_login_reuse_relay',
    });

    const denied = resolveBrowserActionEngine(relayInput({
      requestedEngine: 'auto',
      intent: 'login_reuse',
      relayAuthorization: authorization({ actionScopes: ['click'] }),
    }));
    expect(denied).toMatchObject({
      selectedEngine: 'managed',
      reason: 'auto_login_reuse_managed_recovery',
      recovery: { code: 'SURFACE_APPROVAL_INVALID', selectedEngine: 'managed' },
    });
  });

  it('fails closed when Managed is required but its provider is unavailable', () => {
    const decision = resolveBrowserActionEngine(relayInput({
      requestedEngine: 'auto',
      intent: 'automation',
      managedAvailable: false,
    }));
    expect(decision).toMatchObject({
      selectedEngine: 'managed',
      reason: 'auto_automation_or_preview_unavailable',
      recovery: { code: 'managed_unavailable', selectedEngine: null },
    });
  });
});
