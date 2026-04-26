import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/main/tools/types';

const browserMocks = vi.hoisted(() => {
  const state = {
    running: false,
    tabs: [] as Array<{ id: string; url: string; title: string }>,
    activeTabId: null as string | null,
  };

  const page = {
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({ boundingBox: async () => ({ x: 10, y: 20, width: 30, height: 40 }) })),
    getByRole: vi.fn(() => ({
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      waitFor: vi.fn(async () => undefined),
      boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 30, height: 40 })),
    })),
    locator: vi.fn(() => ({
      all: vi.fn(async () => []),
    })),
  };

  const logger = {
    log: vi.fn(),
    getLogsAsString: vi.fn(() => ''),
  };

  const getActiveTabRecord = () =>
    state.activeTabId
      ? state.tabs.find((tab) => tab.id === state.activeTabId) || null
      : null;

  const targetRef = {
    refId: 'tref_snapshot-1_1',
    source: 'dom',
    selector: '#phase2-button',
    role: null,
    name: 'Run Phase2',
    textHint: 'Run Phase2',
    frameId: null,
    tabId: 'tab-1',
    snapshotId: 'snapshot-1',
    capturedAtMs: 1,
    ttlMs: 60_000,
    confidence: 0.95,
  };

  const accountState = {
    status: 'available',
    cookieCount: 1,
    expiredCookieCount: 0,
    originCount: 1,
    localStorageEntryCount: 1,
    sessionStorageEntryCount: 0,
    cookieDomains: ['example.com'],
    origins: ['https://example.com'],
    updatedAtMs: 1,
    storageStatePath: '/tmp/storage-state.json',
  };

  const artifact = {
    artifactId: 'download_1',
    kind: 'download',
    name: 'report.txt',
    artifactPath: '/tmp/code-agent-managed/report.txt',
    size: 12,
    mimeType: 'text/plain',
    sha256: 'a'.repeat(64),
    createdAtMs: 1,
    sessionId: 'browser_session_mock',
  };

  const service = {
    logger,
    getSessionState: vi.fn(() => {
      const activeTab = getActiveTabRecord();
      return {
        running: state.running,
        tabCount: state.tabs.length,
        activeTab: activeTab
          ? {
              id: activeTab.id,
              url: activeTab.url,
              title: activeTab.title,
            }
          : null,
        mode: 'headless',
        sessionId: 'browser_session_mock',
        profileId: 'managed-browser-profile',
        profileMode: 'persistent',
        workspaceScope: 'code-agent',
        artifactDir: 'screenshots',
        lease: {
          leaseId: 'lease_mock',
          owner: 'browser-action',
          acquiredAtMs: 1,
          lastHeartbeatAtMs: 2,
          expiresAtMs: 60_000,
          ttlMs: 60_000,
          status: 'active',
        },
        proxy: {
          mode: 'direct',
          server: null,
          bypass: [],
          source: 'default',
          regionHint: null,
        },
        externalBridge: {
          enabled: false,
          status: 'unsupported',
          requiresExplicitAuthorization: true,
          reason: 'External browser attach disabled.',
        },
        accountState,
        profileDir: '/tmp/profile',
        viewport: { width: 1280, height: 720 },
        allowedHosts: [],
        blockedHosts: [],
        lastTrace: null,
      };
    }),
    ensureSession: vi.fn(async (url?: string) => {
      state.running = true;
      if (!getActiveTabRecord()) {
        const tab = {
          id: 'tab-1',
          url: url || 'about:blank',
          title: url ? 'Managed Session' : 'about:blank',
        };
        state.tabs = [tab];
        state.activeTabId = tab.id;
      }
      return service.getSessionState();
    }),
    launch: vi.fn(async () => {
      state.running = true;
    }),
    close: vi.fn(async () => {
      state.running = false;
      state.tabs = [];
      state.activeTabId = null;
    }),
    newTab: vi.fn(async (url?: string) => {
      state.running = true;
      const tab = {
        id: `tab-${state.tabs.length + 1}`,
        url: url || 'about:blank',
        title: url ? 'New Tab' : 'about:blank',
      };
      state.tabs.push(tab);
      state.activeTabId = tab.id;
      return tab.id;
    }),
    listTabs: vi.fn(() => state.tabs.map((tab) => ({ ...tab }))),
    navigate: vi.fn(async (url: string) => {
      const activeTab = getActiveTabRecord();
      if (!activeTab) {
        throw new Error('No active tab. Create a new tab first.');
      }
      activeTab.url = url;
      activeTab.title = 'Example';
    }),
    getPageContent: vi.fn(async () => ({
      url: getActiveTabRecord()?.url || 'about:blank',
      title: getActiveTabRecord()?.title || 'about:blank',
      text: 'example page',
      links: [],
    })),
    getDomSnapshot: vi.fn(async () => ({
      snapshotId: 'snapshot-1',
      tabId: 'tab-1',
      capturedAtMs: 1,
      url: getActiveTabRecord()?.url || 'about:blank',
      title: getActiveTabRecord()?.title || 'about:blank',
      headings: [{ level: 1, text: 'Example' }],
      interactiveElements: [{
        tag: 'button',
        role: null,
        text: 'Run Phase2',
        ariaLabel: null,
        placeholder: null,
        selectorHint: '#phase2-button',
        targetRef,
        rect: { x: 10, y: 20, width: 100, height: 30 },
      }],
    })),
    getAccessibilitySnapshot: vi.fn(async () => ({
      role: 'WebArea',
      name: 'Example',
    })),
    setViewport: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    clickTargetRef: vi.fn(async () => targetRef),
    typeTargetRef: vi.fn(async () => targetRef),
    getAccountStateSummary: vi.fn(async () => accountState),
    exportStorageState: vi.fn(async () => ({
      path: '/tmp/storage-state.json',
      accountState,
    })),
    importStorageState: vi.fn(async () => accountState),
    waitForDownload: vi.fn(async () => artifact),
    uploadFile: vi.fn(async () => ({ ...artifact, artifactId: 'upload_1', kind: 'upload' })),
    beginTrace: vi.fn((args: { toolName: string; action: string; params?: Record<string, unknown> }) => ({
      id: 'trace-1',
      targetKind: 'browser',
      toolName: args.toolName,
      action: args.action,
      mode: 'headless',
      startedAtMs: 1,
      before: null,
      params: args.params?.secretRef
        ? { ...args.params, secretRef: '[secretRef]' }
        : args.params || {},
    })),
    finishTrace: vi.fn((trace: any, args: { success: boolean; error?: string | null; screenshotPath?: string | null }) => ({
      ...trace,
      completedAtMs: 2,
      success: args.success,
      error: args.error || null,
      screenshotPath: args.screenshotPath || null,
      after: {
        url: getActiveTabRecord()?.url || 'about:blank',
        title: getActiveTabRecord()?.title || 'about:blank',
        capturedAtMs: 2,
      },
      consoleErrors: [],
      networkFailures: [],
    })),
    isRunning: vi.fn(() => state.running),
    getActiveTab: vi.fn(() => {
      const activeTab = getActiveTabRecord();
      return activeTab
        ? {
            id: activeTab.id,
            url: activeTab.url,
            title: activeTab.title,
            page,
          }
        : null;
    }),
  };

  return { state, page, logger, service, targetRef, accountState, artifact };
});

vi.mock('../../../../src/main/services/infra/browserService.js', () => ({
  browserService: browserMocks.service,
  redactBrowserWorkbenchTraceParams: (_toolName: string, params: Record<string, unknown>) => {
    const redacted = { ...(params || {}) };
    if ('secretRef' in redacted) {
      redacted.secretRef = '[secretRef]';
    }
    if (typeof redacted.uploadFilePath === 'string') {
      redacted.uploadFilePath = redacted.uploadFilePath.split('/').filter(Boolean).pop() || '[path]';
    }
    if (typeof redacted.storageStatePath === 'string') {
      redacted.storageStatePath = redacted.storageStatePath.split('/').filter(Boolean).pop() || '[path]';
    }
    return redacted;
  },
}));

vi.mock('../../../../src/main/services/cloud/featureFlagService', () => ({
  isComputerUseEnabled: () => true,
}));

vi.mock('../../../../src/main/services', () => ({
  getConfigService: () => ({
    getApiKey: () => null,
  }),
}));

import { BrowserTool } from '../../../../src/main/tools/vision/BrowserTool';
import { browserActionTool } from '../../../../src/main/tools/vision/browserAction';
import { computerUseTool } from '../../../../src/main/tools/vision/computerUse';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDirectory: '/tmp/workbench',
    requestPermission: async () => true,
    ...overrides,
  };
}

describe('browser workbench gating', () => {
  beforeEach(() => {
    browserMocks.state.running = false;
    browserMocks.state.tabs = [];
    browserMocks.state.activeTabId = null;

    browserMocks.page.click.mockClear();
    browserMocks.page.fill.mockClear();
    browserMocks.page.hover.mockClear();
    browserMocks.logger.log.mockClear();
    browserMocks.logger.getLogsAsString.mockClear();

    browserMocks.service.getSessionState.mockClear();
    browserMocks.service.ensureSession.mockClear();
    browserMocks.service.launch.mockClear();
    browserMocks.service.close.mockClear();
    browserMocks.service.newTab.mockClear();
    browserMocks.service.listTabs.mockClear();
    browserMocks.service.navigate.mockClear();
    browserMocks.service.getPageContent.mockClear();
    browserMocks.service.getDomSnapshot.mockClear();
    browserMocks.service.getAccessibilitySnapshot.mockClear();
    browserMocks.service.setViewport.mockClear();
    browserMocks.service.type.mockClear();
    browserMocks.service.clickTargetRef.mockClear();
    browserMocks.service.typeTargetRef.mockClear();
    browserMocks.service.getAccountStateSummary.mockClear();
    browserMocks.service.exportStorageState.mockClear();
    browserMocks.service.importStorageState.mockClear();
    browserMocks.service.waitForDownload.mockClear();
    browserMocks.service.uploadFile.mockClear();
    browserMocks.service.beginTrace.mockClear();
    browserMocks.service.finishTrace.mockClear();
    browserMocks.service.isRunning.mockClear();
    browserMocks.service.getActiveTab.mockClear();
  });

  it('returns structured DOM snapshots through browser_action', async () => {
    browserMocks.state.running = true;
    browserMocks.state.tabs = [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }];
    browserMocks.state.activeTabId = 'tab-1';

    const result = await browserActionTool.execute(
      {
        action: 'get_dom_snapshot',
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.domSnapshot).toMatchObject({
      snapshotId: 'snapshot-1',
      url: 'https://example.com',
      headings: [{ level: 1, text: 'Example' }],
      interactiveElements: [{
        selectorHint: '#phase2-button',
        targetRef: {
          refId: 'tref_snapshot-1_1',
          source: 'dom',
          snapshotId: 'snapshot-1',
        },
      }],
    });
    expect(result.metadata?.traceId).toBe('trace-1');
  });

  it('clicks browser targetRef returned by a DOM snapshot', async () => {
    browserMocks.state.running = true;
    browserMocks.state.tabs = [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }];
    browserMocks.state.activeTabId = 'tab-1';

    const result = await browserActionTool.execute(
      {
        action: 'click',
        targetRef: browserMocks.targetRef,
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(browserMocks.service.clickTargetRef).toHaveBeenCalledWith(browserMocks.targetRef, undefined);
    expect(result.output).toContain('targetRef');
    expect(result.metadata?.targetRef).toMatchObject({
      refId: 'tref_snapshot-1_1',
      selector: '#phase2-button',
      snapshotId: 'snapshot-1',
    });
  });

  it('returns a recoverable stale targetRef error with a refresh hint', async () => {
    browserMocks.state.running = true;
    browserMocks.state.tabs = [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }];
    browserMocks.state.activeTabId = 'tab-1';
    const staleError = Object.assign(new Error('TargetRef tref_old is stale after navigation. Refresh the DOM snapshot and retry.'), {
      code: 'STALE_TARGET_REF',
      recoverable: true,
      retryHint: 'Run browser_action.get_dom_snapshot and retry with a fresh targetRef.',
      refId: 'tref_old',
      snapshotId: 'snapshot-old',
    });
    browserMocks.service.clickTargetRef.mockRejectedValueOnce(staleError);

    const result = await browserActionTool.execute(
      {
        action: 'click',
        targetRef: {
          refId: 'tref_old',
          snapshotId: 'snapshot-old',
        },
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Recovery');
    expect(result.error).toContain('fresh targetRef');
    expect(result.metadata?.code).toBe('STALE_TARGET_REF');
    expect(result.metadata?.browserComputerRecoveryActionOutcome).toMatchObject({
      status: 'recoverable',
      retryHint: 'Run browser_action.get_dom_snapshot and retry with a fresh targetRef.',
    });
  });

  it('updates managed browser viewport through browser_action', async () => {
    browserMocks.state.running = true;
    browserMocks.state.tabs = [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }];
    browserMocks.state.activeTabId = 'tab-1';

    const result = await browserActionTool.execute(
      {
        action: 'set_viewport',
        width: 390,
        height: 844,
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(browserMocks.service.setViewport).toHaveBeenCalledWith(390, 844);
    expect(result.metadata?.viewport).toEqual({ width: 390, height: 844 });
  });

  it('blocks browser_action automation when desktop mode disables managed browser automation', async () => {
    const result = await browserActionTool.execute(
      {
        action: 'navigate',
        url: 'https://example.com',
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'desktop',
          preferBrowserSession: true,
          preferDesktopContext: true,
          allowBrowserAutomation: false,
          browserSessionSnapshot: {
            ready: true,
          },
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('allowBrowserAutomation=false');
    expect(browserMocks.service.navigate).not.toHaveBeenCalled();
  });

  it('auto-ensures the managed browser session when browser_action runs under managed mode', async () => {
    const result = await browserActionTool.execute(
      {
        action: 'navigate',
        url: 'https://example.com',
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(browserMocks.service.ensureSession).toHaveBeenCalledWith('about:blank', {
      leaseOwner: 'browser_workbench',
    });
    expect(browserMocks.service.navigate).toHaveBeenCalledWith('https://example.com', undefined);
    expect(result.output).toContain('自动启动了托管浏览器');
    expect(result.output).toContain('Navigated to: https://example.com');
    expect(result.metadata?.traceId).toBe('trace-1');
    expect(browserMocks.service.finishTrace).toHaveBeenCalledWith(expect.objectContaining({
      action: 'navigate',
    }), expect.objectContaining({ success: true }));
  });

  it('makes Browser.open prefer the managed browser session when managed mode is selected', async () => {
    const result = await BrowserTool.execute(
      {
        action: 'open',
        url: 'https://example.com',
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(browserMocks.service.navigate).toHaveBeenCalledWith('https://example.com', undefined);
    expect(result.output).toContain('改走托管浏览器会话');
  });

  it('does not echo typed browser text in browser_action source output', async () => {
    browserMocks.state.running = true;
    browserMocks.state.tabs = [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }];
    browserMocks.state.activeTabId = 'tab-1';

    const result = await browserActionTool.execute(
      {
        action: 'type',
        selector: '#email',
        text: 'secret@example.com',
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(browserMocks.service.type).toHaveBeenCalledWith('#email', 'secret@example.com', undefined);
    expect(result.output).toContain('18 chars');
    expect(result.output).not.toContain('secret@example.com');
  });

  it('types browser secretRef without echoing the resolved secret', async () => {
    browserMocks.state.running = true;
    browserMocks.state.tabs = [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }];
    browserMocks.state.activeTabId = 'tab-1';
    const envName = 'BROWSER_REDACTION_FIXTURE_VALUE';
    const fixtureValue = 'redacted-fixture-value';
    process.env[envName] = fixtureValue;

    try {
      const result = await browserActionTool.execute(
        {
          action: 'type',
          selector: '#password',
          secretRef: `env:${envName}`,
        },
        makeContext({
          executionIntent: {
            browserSessionMode: 'managed',
            preferBrowserSession: true,
            allowBrowserAutomation: true,
          },
        }),
      );

      expect(result.success).toBe(true);
      expect(browserMocks.service.type).toHaveBeenCalledWith('#password', fixtureValue, undefined);
      expect(result.output).toContain('secretRef');
      expect(result.output).not.toContain(fixtureValue);
      expect(result.output).not.toContain(envName);
      expect(result.metadata?.workbenchTrace).toMatchObject({
        params: {
          action: 'type',
          selector: '#password',
          secretRef: '[secretRef]',
        },
      });
    } finally {
      delete process.env[envName];
    }
  });

  it('exports and imports browser storageState without returning cookie values', async () => {
    browserMocks.state.running = true;
    browserMocks.state.tabs = [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }];
    browserMocks.state.activeTabId = 'tab-1';

    const exportResult = await browserActionTool.execute(
      {
        action: 'export_storage_state',
        storageStatePath: '/tmp/storage-state.json',
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );
    const importResult = await browserActionTool.execute(
      {
        action: 'import_storage_state',
        storageStatePath: '/tmp/storage-state.json',
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(exportResult.success).toBe(true);
    expect(importResult.success).toBe(true);
    expect(browserMocks.service.exportStorageState).toHaveBeenCalledWith('/tmp/storage-state.json');
    expect(browserMocks.service.importStorageState).toHaveBeenCalledWith('/tmp/storage-state.json');
    expect(exportResult.metadata?.browserAccountState).toMatchObject({
      status: 'available',
      cookieCount: 1,
      localStorageEntryCount: 1,
      storageStatePath: '.../storage-state.json',
    });
    expect(JSON.stringify(exportResult)).not.toContain('cookie-secret');
    expect(JSON.stringify(importResult)).not.toContain('cookie-secret');
  });

  it('downloads browser artifacts with summary metadata', async () => {
    browserMocks.state.running = true;
    browserMocks.state.tabs = [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }];
    browserMocks.state.activeTabId = 'tab-1';

    const result = await browserActionTool.execute(
      {
        action: 'wait_for_download',
        targetRef: browserMocks.targetRef,
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(browserMocks.service.waitForDownload).toHaveBeenCalledWith({
      selector: undefined,
      targetRef: browserMocks.targetRef,
    }, undefined);
    expect(result.output).toContain('report.txt');
    expect(result.metadata?.browserArtifact).toMatchObject({
      kind: 'download',
      name: 'report.txt',
      artifactPath: '.../report.txt',
      size: 12,
      sha256: 'a'.repeat(64),
    });
    expect(JSON.stringify(result)).not.toContain('/tmp/code-agent-managed/report.txt');
  });

  it('returns a readable failure reason when browser download does not complete', async () => {
    browserMocks.state.running = true;
    browserMocks.state.tabs = [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }];
    browserMocks.state.activeTabId = 'tab-1';
    browserMocks.service.waitForDownload.mockRejectedValueOnce(new Error('Timeout waiting for download event'));

    const result = await browserActionTool.execute(
      {
        action: 'wait_for_download',
        selector: '#broken-download',
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Timeout waiting for download event');
    expect(result.metadata?.workbenchTrace).toMatchObject({
      action: 'wait_for_download',
      success: false,
    });
  });

  it('requires permission for sensitive upload files and hides the raw path', async () => {
    browserMocks.state.running = true;
    browserMocks.state.tabs = [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }];
    browserMocks.state.activeTabId = 'tab-1';

    const result = await browserActionTool.execute(
      {
        action: 'upload_file',
        selector: '#file',
        uploadFilePath: `${process.env.HOME || '/Users/linchen'}/Downloads/secret.env`,
      },
      makeContext({
        requestPermission: async (request) => {
          expect(request.tool).toBe('browser_action.upload_file');
          expect(request.details.file).toBe('.../secret.env');
          return true;
        },
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(browserMocks.service.uploadFile).toHaveBeenCalledWith({
      filePath: `${process.env.HOME || '/Users/linchen'}/Downloads/secret.env`,
      selector: '#file',
      targetRef: undefined,
      tabId: undefined,
    });
    expect(result.output).toContain('report.txt');
    expect(JSON.stringify(result)).not.toContain('/Downloads/secret.env');
  });

  it('returns public managed session state through browser_action get_workbench_state', async () => {
    browserMocks.state.running = true;
    browserMocks.state.tabs = [{ id: 'tab-1', url: 'https://example.com/docs?token=abc', title: 'Example' }];
    browserMocks.state.activeTabId = 'tab-1';

    const result = await browserActionTool.execute(
      {
        action: 'get_workbench_state',
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('browser_session_mock');
    expect(result.output).toContain('managed-browser-profile');
    expect(result.metadata?.browserWorkbenchState).toMatchObject({
      lease: {
        leaseId: 'lease_mock',
        status: 'active',
      },
      proxy: {
        mode: 'direct',
        source: 'default',
      },
      externalBridge: {
        status: 'unsupported',
        requiresExplicitAuthorization: true,
      },
    });
    expect(result.output).toContain('https://example.com/docs');
    expect(result.output).not.toContain('/tmp/profile');
    expect(result.output).not.toContain('token=abc');
  });

  it('blocks computer_use when desktop workbench reports the desktop context is not ready', async () => {
    const result = await computerUseTool.execute(
      {
        action: 'smart_click',
        selector: '#submit',
      },
      makeContext({
        executionIntent: {
          browserSessionMode: 'desktop',
          preferBrowserSession: true,
          preferDesktopContext: true,
          allowBrowserAutomation: false,
          browserSessionSnapshot: {
            ready: false,
            blockedDetail: '当前桌面浏览器上下文未就绪：辅助功能未授权、collector 未启动。',
            blockedHint: '先补权限并启动采集。',
          },
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('当前桌面浏览器上下文未就绪');
    expect(result.error).toContain('先补权限并启动采集');
    expect(browserMocks.page.click).not.toHaveBeenCalled();
  });
});
