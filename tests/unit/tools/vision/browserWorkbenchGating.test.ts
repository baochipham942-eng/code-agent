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

  return { state, page, logger, service };
});

vi.mock('../../../../src/main/services/infra/browserService.js', () => ({
  browserService: browserMocks.service,
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
    browserMocks.service.isRunning.mockClear();
    browserMocks.service.getActiveTab.mockClear();
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
    expect(browserMocks.service.ensureSession).toHaveBeenCalledWith('https://example.com');
    expect(browserMocks.service.navigate).toHaveBeenCalledWith('https://example.com', undefined);
    expect(result.output).toContain('自动启动了托管浏览器');
    expect(result.output).toContain('Navigated to: https://example.com');
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
