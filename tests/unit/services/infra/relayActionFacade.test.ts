import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listTabs,
  createTab,
  navigateTab,
  attachTab,
  detachTab,
  screenshotTab,
  sendCdp,
  ensureStarted,
  getState,
} = vi.hoisted(() => ({
  listTabs: vi.fn(),
  createTab: vi.fn(),
  navigateTab: vi.fn(),
  attachTab: vi.fn(),
  detachTab: vi.fn(),
  screenshotTab: vi.fn(),
  sendCdp: vi.fn(),
  ensureStarted: vi.fn(),
  getState: vi.fn(),
}));

vi.mock('../../../../src/host/services/infra/browserRelayService', () => ({
  browserRelayService: {
    listTabs,
    createTab,
    navigateTab,
    attachTab,
    detachTab,
    screenshotTab,
    sendCdp,
    ensureStarted,
    getState,
  },
}));

import { executeRelayBrowserAction } from '../../../../src/host/services/infra/browser/relayActionFacade';

describe('relayActionFacade (ADR-041 M3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getState.mockReturnValue({
      enabled: true,
      status: 'connected',
      requiresExplicitAuthorization: true,
      attachedTabCount: 1,
      connectedTabCount: 1,
    });
    listTabs.mockResolvedValue([
      { id: 7, title: 'Example', url: 'https://example.com', attached: true, active: true },
    ]);
    sendCdp.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: true } };
      }
      return {};
    });
  });

  it('lists tabs through the relay host', async () => {
    const result = await executeRelayBrowserAction({ action: 'list_tabs' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Example');
    expect(result.metadata?.provider).toBe('browser-relay');
  });

  it('clicks via Runtime.evaluate on the attached tab', async () => {
    const result = await executeRelayBrowserAction({
      action: 'click',
      selector: 'button.submit',
    });
    expect(result.success).toBe(true);
    expect(sendCdp).toHaveBeenCalledWith(
      7,
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('button.submit') }),
    );
  });

  it('fails closed when no attached tab exists', async () => {
    getState.mockReturnValue({
      enabled: true,
      status: 'connected',
      requiresExplicitAuthorization: true,
      attachedTabCount: 0,
      connectedTabCount: 1,
    });
    const result = await executeRelayBrowserAction({ action: 'get_content' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/attach/i);
  });

  it('marks managed-only actions as unsupported on relay', async () => {
    const result = await executeRelayBrowserAction({ action: 'import_profile_cookies' });
    expect(result.success).toBe(false);
    expect(result.metadata?.capability).toBe('managed_only');
  });
});
