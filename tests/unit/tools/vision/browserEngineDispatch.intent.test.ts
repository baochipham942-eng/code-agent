import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedBrowserExternalBridgeState } from '../../../../src/shared/contract/desktop';
import type { ToolContext } from '../../../../src/host/tools/types';

vi.mock('../../../../src/host/services/infra/browserRelayService', () => ({
  browserRelayService: {
    getState: vi.fn(),
  },
}));

vi.mock('../../../../src/host/services/infra/browser/relayActionFacade', () => ({
  executeRelayBrowserAction: vi.fn(async () => ({ success: true, output: 'ok', metadata: {} })),
}));

vi.mock('../../../../src/host/tools/vision/browserUploadApproval', () => ({
  requestBrowserUploadApproval: vi.fn(),
}));

vi.mock('../../../../src/host/services/surfaceExecution/RelayBrowserProviderAdapter', () => ({
  getRelayBrowserProviderAdapter: vi.fn(() => ({
    hasReadyLease: vi.fn(),
    getBinding: vi.fn(),
  })),
}));

vi.mock('../../../../src/host/services/infra/browserService.js', () => ({
  browserService: {
    beginTrace: vi.fn(() => ({ traceId: 'trace-1' })),
    finishTrace: vi.fn(),
  },
  redactBrowserWorkbenchTraceParams: (_toolName: string, params: Record<string, unknown>) => ({
    ...(params || {}),
    ...(typeof params?.uploadFilePath === 'string' ? { uploadFilePath: '[redacted-path]' } : {}),
  }),
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
import { executeRelayBrowserAction } from '../../../../src/host/services/infra/browser/relayActionFacade';
import { getRelayBrowserProviderAdapter } from '../../../../src/host/services/surfaceExecution/RelayBrowserProviderAdapter';
import { requestBrowserUploadApproval } from '../../../../src/host/tools/vision/browserUploadApproval';

const hasReadyLease = vi.fn();
const getBinding = vi.fn();

function readyBinding(overrides: Record<string, unknown> = {}) {
  return {
    identity: {
      conversationId: 'conversation-1',
      runId: 'run-1',
      agentId: 'agent-1',
    },
    target: {
      browserInstanceId: 'browser:relay-1',
      windowRef: 'window:agent-1',
      tabRef: 'tab:opaque-1',
      origin: 'https://github.com',
      documentRevision: 'document:1',
    },
    lease: {
      state: 'leased',
      expiresAt: Date.now() + 60_000,
      actionScopes: ['get_content', 'click', 'navigate', 'lease:return'],
      domainScopes: ['origin:https://github.com'],
    },
    ...overrides,
  };
}

function relayState(partial: Partial<ManagedBrowserExternalBridgeState> = {}): ManagedBrowserExternalBridgeState {
  return {
    enabled: true,
    status: 'connected',
    requiresExplicitAuthorization: true,
    connectedTabCount: 1,
    attachedTabCount: 99,
    ...partial,
  };
}

function toolContext(partial: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDirectory: '/tmp/workbench',
    requestPermission: async () => true,
    sessionId: 'conversation-1',
    runId: 'run-1',
    agentId: 'agent-1',
    currentToolCallId: 'operation-1',
    ...partial,
  };
}

describe('owner-scoped Relay dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(browserRelayService.getState).mockReturnValue(relayState());
    hasReadyLease.mockReturnValue(false);
    getBinding.mockReturnValue(null);
    vi.mocked(getRelayBrowserProviderAdapter).mockReturnValue({ hasReadyLease, getBinding } as never);
    vi.mocked(executeRelayBrowserAction).mockResolvedValue({ success: true, output: 'ok', metadata: {} });
    vi.mocked(requestBrowserUploadApproval).mockResolvedValue({
      approved: true,
      relayToken: 'relay-upload-token-opaque',
      file: {
        normalizedPath: '/private/tmp/internal-only.txt',
        name: 'internal-only.txt',
        size: 10,
        sha256: 'a'.repeat(64),
        device: 1,
        inode: 2,
        modifiedAtMs: 3,
      },
    });
  });

  it('routes login_reuse to Relay only when this owner has a live lease', async () => {
    hasReadyLease.mockImplementation(({ runId }: { runId: string }) => runId === 'run-with-lease');
    const owner = toolContext({ runId: 'run-with-lease' });
    getBinding.mockReturnValue(readyBinding({
      identity: { conversationId: 'conversation-1', runId: 'run-with-lease', agentId: 'agent-1' },
    }));

    const result = await maybeDispatchRelayBrowserAction({
      action: 'get_content',
      params: {},
      url: 'https://github.com/settings',
      executionIntent: { browserSessionMode: 'desktop' },
      context: owner,
    });

    expect(hasReadyLease).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      runId: 'run-with-lease',
      agentId: 'agent-1',
    });
    expect(result?.metadata?.engineRoute).toMatchObject({
      selectedEngine: 'relay',
      reason: 'auto_login_reuse_relay',
    });
    expect(executeRelayBrowserAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'get_content' }),
      owner,
    );
  });

  it('keeps auto on Managed even while Relay is connected and this owner has a lease', async () => {
    hasReadyLease.mockReturnValue(true);
    getBinding.mockReturnValue(readyBinding());

    const result = await maybeDispatchRelayBrowserAction({
      action: 'get_content',
      params: {},
      url: 'https://github.com/settings',
      context: toolContext(),
    });

    expect(result).toBeNull();
    expect(executeRelayBrowserAction).not.toHaveBeenCalled();
  });

  it('falls back to Managed for login_reuse when only transport state exists', async () => {
    const result = await maybeDispatchRelayBrowserAction({
      action: 'get_content',
      params: {},
      url: 'https://github.com/settings',
      executionIntent: { browserSessionMode: 'desktop' },
      context: toolContext(),
    });

    expect(result).toBeNull();
    expect(executeRelayBrowserAction).not.toHaveBeenCalled();
  });

  it('lets explicit Relay launch open the approval popup when no lease exists', async () => {
    const context = toolContext();

    const result = await maybeDispatchRelayBrowserAction({
      action: 'launch',
      params: {
        engine: 'relay',
        relayDomainScopes: ['https://github.com'],
        relayActionScopes: ['get_content'],
        relayLeaseTtlMs: 30_000,
      },
      context,
    });

    expect(executeRelayBrowserAction).toHaveBeenCalledWith({
      action: 'launch',
      relayDomainScopes: ['https://github.com'],
      relayActionScopes: ['get_content'],
      relayLeaseTtlMs: 30_000,
    }, context);
    expect(result?.success).toBe(true);
    expect(result?.metadata?.engineRoute).toMatchObject({
      selectedEngine: 'relay',
      recovery: { code: 'BROWSER_TAB_BORROW_REQUIRED' },
    });
  });

  it('does not open Relay approval while the provider is not ready', async () => {
    vi.mocked(browserRelayService.getState).mockReturnValue(relayState({ status: 'listening' }));

    const result = await maybeDispatchRelayBrowserAction({
      action: 'launch',
      params: {
        engine: 'relay',
        relayDomainScopes: ['https://github.com'],
        relayActionScopes: ['get_content'],
      },
      context: toolContext(),
    });

    expect(result).toMatchObject({
      success: false,
      metadata: { recovery: { code: 'relay_not_connected' } },
    });
    expect(executeRelayBrowserAction).not.toHaveBeenCalled();
  });

  it('fails closed for explicit Relay actions without a lease', async () => {
    const result = await maybeDispatchRelayBrowserAction({
      action: 'click',
      params: { engine: 'relay', targetRef: { backendNodeId: 7 } },
      context: toolContext(),
    });

    expect(result).toMatchObject({
      success: false,
      metadata: {
        recovery: { code: 'BROWSER_TAB_BORROW_REQUIRED' },
      },
    });
    expect(executeRelayBrowserAction).not.toHaveBeenCalled();
  });

  it('never forwards a native tabId to the Relay facade', async () => {
    hasReadyLease.mockReturnValue(true);
    getBinding.mockReturnValue(readyBinding());

    await maybeDispatchRelayBrowserAction({
      action: 'click',
      params: {
        engine: 'relay',
        tabId: 'raw-chrome-tab-123',
        targetRef: { backendNodeId: 7, frameRef: 'frame-opaque' },
      },
      context: toolContext(),
    });

    const forwarded = vi.mocked(executeRelayBrowserAction).mock.calls[0]?.[0];
    expect(forwarded).toMatchObject({
      action: 'click',
      targetRef: {
        backendNodeId: 7,
        frameRef: 'frame-opaque',
        tabRef: 'tab:opaque-1',
        documentRevision: 'document:1',
      },
    });
    expect(forwarded).not.toHaveProperty('tabId');
    expect(forwarded).not.toHaveProperty('destinationTargetRef');
    expect(JSON.stringify(forwarded)).not.toContain('raw-chrome-tab-123');
  });

  it('blocks unsupported capability and unapproved domain before Relay dispatch', async () => {
    hasReadyLease.mockReturnValue(true);
    getBinding.mockReturnValue(readyBinding());

    const unsupported = await maybeDispatchRelayBrowserAction({
      action: 'wait_for_download',
      params: { engine: 'relay', selector: '#download' },
      context: toolContext(),
    });
    expect(unsupported).toMatchObject({
      success: false,
      metadata: { recovery: { code: 'SURFACE_CAPABILITY_UNSUPPORTED' } },
    });

    const wrongDomain = await maybeDispatchRelayBrowserAction({
      action: 'navigate',
      params: { engine: 'relay', url: 'https://evil.invalid/phish' },
      context: toolContext(),
    });
    expect(wrongDomain).toMatchObject({
      success: false,
      metadata: { recovery: { code: 'SURFACE_APPROVAL_INVALID' } },
    });
    expect(executeRelayBrowserAction).not.toHaveBeenCalled();
  });

  it('requires a fresh exact-file approval and forwards only its opaque token to Relay', async () => {
    hasReadyLease.mockReturnValue(true);
    getBinding.mockReturnValue(readyBinding({
      lease: {
        state: 'leased',
        expiresAt: Date.now() + 60_000,
        actionScopes: ['upload_file', 'lease:return'],
        domainScopes: ['origin:https://github.com'],
      },
    }));
    const context = toolContext();
    const uploadPath = '/private/tmp/surface-secret-canary-relay-upload.txt';

    const result = await maybeDispatchRelayBrowserAction({
      action: 'upload_file',
      params: {
        engine: 'relay',
        uploadFilePath: uploadPath,
        targetRef: {
          ref: 'element:file-input',
          tabRef: 'tab:opaque-1',
          documentRevision: 'document:1',
        },
      },
      context,
    });

    expect(requestBrowserUploadApproval).toHaveBeenCalledWith({
      filePath: uploadPath,
      context,
      engine: 'relay',
    });
    expect(executeRelayBrowserAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'upload_file',
      targetRef: expect.objectContaining({ ref: 'element:file-input' }),
      relayUploadApprovalToken: 'relay-upload-token-opaque',
    }), context);
    const forwarded = vi.mocked(executeRelayBrowserAction).mock.calls.at(-1)?.[0];
    expect(forwarded).not.toHaveProperty('uploadFilePath');
    expect(JSON.stringify(result)).not.toContain(uploadPath);
    expect(JSON.stringify(result)).not.toContain('/private/tmp/');
  });

  it('rejects selector-only Relay upload before asking for file approval', async () => {
    hasReadyLease.mockReturnValue(true);
    getBinding.mockReturnValue(readyBinding({
      lease: {
        state: 'leased',
        expiresAt: Date.now() + 60_000,
        actionScopes: ['upload_file', 'lease:return'],
        domainScopes: ['origin:https://github.com'],
      },
    }));

    const result = await maybeDispatchRelayBrowserAction({
      action: 'upload_file',
      params: {
        engine: 'relay',
        selector: 'input[type=file]',
        uploadFilePath: '/private/tmp/selector-only-canary.txt',
      },
      context: toolContext(),
    });

    expect(result).toMatchObject({
      success: false,
      metadata: { code: 'SURFACE_ELEMENT_REF_NOT_FOUND' },
    });
    expect(requestBrowserUploadApproval).not.toHaveBeenCalled();
    expect(executeRelayBrowserAction).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('/private/tmp/selector-only-canary.txt');
  });

  it('blocks cross-tab and stale element references before Relay dispatch', async () => {
    hasReadyLease.mockReturnValue(true);
    getBinding.mockReturnValue(readyBinding());

    const crossTab = await maybeDispatchRelayBrowserAction({
      action: 'click',
      params: {
        engine: 'relay',
        targetRef: {
          backendNodeId: 7,
          tabRef: 'tab:other-owner',
          documentRevision: 'document:1',
        },
      },
      context: toolContext(),
    });
    expect(crossTab).toMatchObject({
      success: false,
      metadata: { recovery: { code: 'SURFACE_TARGET_NOT_OWNED' } },
    });

    const stale = await maybeDispatchRelayBrowserAction({
      action: 'click',
      params: {
        engine: 'relay',
        targetRef: {
          backendNodeId: 7,
          tabRef: 'tab:opaque-1',
          documentRevision: 'document:old',
        },
      },
      context: toolContext(),
    });
    expect(stale).toMatchObject({
      success: false,
      metadata: { recovery: { code: 'SURFACE_STATE_STALE' } },
    });
    expect(executeRelayBrowserAction).not.toHaveBeenCalled();
  });

  it('fences the drag destination independently from the source target', async () => {
    hasReadyLease.mockReturnValue(true);
    getBinding.mockReturnValue(readyBinding({
      lease: {
        state: 'leased',
        expiresAt: Date.now() + 60_000,
        actionScopes: ['drag', 'lease:return'],
        domainScopes: ['origin:https://github.com'],
      },
    }));

    const result = await maybeDispatchRelayBrowserAction({
      action: 'drag',
      params: {
        engine: 'relay',
        targetRef: {
          ref: 'element:source',
          tabRef: 'tab:opaque-1',
          documentRevision: 'document:1',
        },
        destinationTargetRef: {
          ref: 'element:foreign-destination',
          tabRef: 'tab:other-owner',
          documentRevision: 'document:1',
        },
      },
      context: toolContext(),
    });

    expect(result).toMatchObject({
      success: false,
      metadata: { recovery: { code: 'SURFACE_TARGET_NOT_OWNED' } },
    });
    expect(executeRelayBrowserAction).not.toHaveBeenCalled();
  });

  it('requires a fresh explicit approval before accepting a Relay dialog', async () => {
    hasReadyLease.mockReturnValue(true);
    getBinding.mockReturnValue(readyBinding({
      lease: {
        state: 'leased',
        expiresAt: Date.now() + 60_000,
        actionScopes: ['handle_dialog', 'lease:return'],
        domainScopes: ['origin:https://github.com'],
      },
    }));
    const requestPermission = vi.fn(async () => false);

    const result = await maybeDispatchRelayBrowserAction({
      action: 'handle_dialog',
      params: {
        engine: 'relay',
        dialogAction: 'accept',
        dialogPromptText: 'surface-secret-canary-dialog-input',
      },
      context: toolContext({ requestPermission }),
    });

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'browser_action.handle_dialog',
      forceConfirm: true,
      dangerLevel: 'danger',
      details: {
        action: 'handle_dialog',
        dialogAction: 'accept',
        hasPromptText: true,
      },
    }));
    expect(JSON.stringify(requestPermission.mock.calls)).not.toContain('surface-secret-canary-dialog-input');
    expect(result).toMatchObject({
      success: false,
      metadata: { code: 'SURFACE_APPROVAL_REQUIRED' },
    });
    expect(executeRelayBrowserAction).not.toHaveBeenCalled();
  });

  it('browser_action passes the complete owner context through to login_reuse dispatch', async () => {
    hasReadyLease.mockReturnValue(true);
    getBinding.mockReturnValue(readyBinding());
    const context = toolContext({ executionIntent: { browserSessionMode: 'desktop' } });

    const result = await browserActionTool.execute(
      { action: 'get_content', url: 'https://github.com/settings' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.engineRoute).toMatchObject({ reason: 'auto_login_reuse_relay' });
    expect(executeRelayBrowserAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'get_content' }),
      context,
    );
  });
});
