import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedBrowserExternalBridgeState } from '../../../../src/shared/contract/desktop';

vi.mock('../../../../src/host/services/infra/browserRelayService', () => ({
  browserRelayService: {
    getState: vi.fn(),
  },
}));

vi.mock('../../../../src/host/services/infra/browser/relayActionFacade', () => ({
  executeRelayBrowserAction: vi.fn(async () => ({ success: true, output: 'ok', metadata: {} })),
}));

vi.mock('../../../../src/host/services/infra/browserService.js', () => ({
  browserService: {
    beginTrace: vi.fn(() => ({ traceId: 'trace-1' })),
    finishTrace: vi.fn(),
  },
  redactBrowserWorkbenchTraceParams: (_toolName: string, params: Record<string, unknown>) => ({ ...(params || {}) }),
}));

vi.mock('../../../../src/host/services/infra/browserPool.js', () => ({
  getBrowserService: vi.fn(),
}));

vi.mock('../../../../src/host/services/desktop/visionAnalysisService', () => ({
  analyzeImageWithVision: vi.fn(),
}));

import { maybeDispatchRelayBrowserAction } from '../../../../src/host/tools/vision/browserEngineDispatch';
import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';
import { browserRelayService } from '../../../../src/host/services/infra/browserRelayService';

function relayState(partial: Partial<ManagedBrowserExternalBridgeState>): ManagedBrowserExternalBridgeState {
  return {
    enabled: true,
    status: 'connected',
    attachedTabCount: 1,
    ...partial,
  } as ManagedBrowserExternalBridgeState;
}

describe('relay dispatch login_reuse intent mapping (ADR-041 follow-up)', () => {
  beforeEach(() => {
    vi.mocked(browserRelayService.getState).mockReturnValue(relayState({}));
  });

  it('desktop workbench intent + ready relay routes auto engine as auto_login_reuse_relay', async () => {
    const result = await maybeDispatchRelayBrowserAction({
      action: 'get_content',
      params: {},
      url: 'https://github.com/settings',
      executionIntent: { browserSessionMode: 'desktop' },
    });
    expect(result).not.toBeNull();
    const engineRoute = result?.metadata?.engineRoute as { reason?: string } | undefined;
    expect(engineRoute?.reason).toBe('auto_login_reuse_relay');
  });

  it('no intent + ready relay still routes to relay but as auto_relay_ready', async () => {
    const result = await maybeDispatchRelayBrowserAction({
      action: 'get_content',
      params: {},
      url: 'https://github.com/settings',
    });
    expect(result).not.toBeNull();
    const engineRoute = result?.metadata?.engineRoute as { reason?: string } | undefined;
    expect(engineRoute?.reason).toBe('auto_relay_ready');
  });

  it('desktop intent with relay offline falls back to managed path (null)', async () => {
    vi.mocked(browserRelayService.getState).mockReturnValue(
      relayState({ status: 'stopped', attachedTabCount: 0 }),
    );
    const result = await maybeDispatchRelayBrowserAction({
      action: 'get_content',
      params: {},
      url: 'https://github.com/settings',
      executionIntent: { browserSessionMode: 'desktop' },
    });
    expect(result).toBeNull();
  });

  it('browser_action passes ToolContext.executionIntent through to relay dispatch', async () => {
    const result = await browserActionTool.execute(
      { action: 'get_content', url: 'https://github.com/settings' },
      {
        workingDirectory: '/tmp/workbench',
        requestPermission: async () => true,
        executionIntent: { browserSessionMode: 'desktop' },
      },
    );
    expect(result.success).toBe(true);
    const engineRoute = result.metadata?.engineRoute as { reason?: string } | undefined;
    expect(engineRoute?.reason).toBe('auto_login_reuse_relay');
  });

  it('managed workbench intent does not map to login_reuse', async () => {
    vi.mocked(browserRelayService.getState).mockReturnValue(
      relayState({ status: 'stopped', attachedTabCount: 0 }),
    );
    const result = await maybeDispatchRelayBrowserAction({
      action: 'get_content',
      params: {},
      url: 'https://github.com/settings',
      executionIntent: { browserSessionMode: 'managed' },
    });
    expect(result).toBeNull();
  });
});
