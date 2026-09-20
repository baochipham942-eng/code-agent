// ============================================================================
// browser_action captcha takeover gate (N-BROWSER-CAPTCHA-TAKEOVER)
// JBS-09 题面主路径回归：页面含人机验证标记时，变更动作被门拦，
// 审批被拒时 captchaClicked=0；只读动作不受影响。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, PermissionRequestData } from '../../../../src/host/tools/types';

const browserMocks = vi.hoisted(() => {
  const state = {
    running: false,
    tabs: [] as Array<{ id: string; url: string; title: string }>,
    activeTabId: null as string | null,
    pageText: 'example page',
  };

  const page = {
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
  };

  const service = {
    logger: {
      log: vi.fn(),
      getLogsAsString: vi.fn(() => ''),
    },
    getSessionState: vi.fn(() => ({
      running: state.running,
      tabCount: state.tabs.length,
      activeTab: null,
      mode: 'headless',
      sessionId: 'browser_session_mock',
    })),
    launch: vi.fn(async () => {
      state.running = true;
    }),
    close: vi.fn(async () => {
      state.running = false;
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
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      if (!activeTab) throw new Error('No active tab');
      activeTab.url = url;
      activeTab.title = 'Page';
    }),
    getPageContent: vi.fn(async () => ({
      url: state.tabs.find((t) => t.id === state.activeTabId)?.url || 'about:blank',
      title: state.tabs.find((t) => t.id === state.activeTabId)?.title || 'about:blank',
      text: state.pageText,
      links: [],
    })),
    getElementBoundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 100, height: 30 })),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    pressKey: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => ({ success: true, path: '/tmp/browser-shot.png' })),
    getDomSnapshot: vi.fn(async () => ({
      snapshotId: 'snapshot-1',
      tabId: 'tab-1',
      capturedAtMs: 1,
      url: 'https://example.com/captcha',
      title: 'Verify',
      headings: [],
      interactiveElements: [],
    })),
    beginTrace: vi.fn((args: { toolName: string; action: string; params?: Record<string, unknown> }) => ({
      id: 'trace-1',
      targetKind: 'browser',
      toolName: args.toolName,
      action: args.action,
      mode: 'headless',
      startedAtMs: 1,
      before: null,
      params: args.params || {},
    })),
    finishTrace: vi.fn((trace: Record<string, unknown>, args: { success: boolean; error?: string | null }) => ({
      ...trace,
      completedAtMs: 2,
      success: args.success,
      error: args.error || null,
      after: null,
      consoleErrors: [],
      networkFailures: [],
    })),
    isRunning: vi.fn(() => state.running),
    getActiveTab: vi.fn(() => {
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      return activeTab ? { ...activeTab, page } : null;
    }),
  };

  return { state, page, service };
});

vi.mock('../../../../src/host/services/infra/browserService.js', () => ({
  browserService: browserMocks.service,
  redactBrowserWorkbenchTraceParams: (_toolName: string, params: Record<string, unknown>) => params,
}));

vi.mock('../../../../src/host/services/cloud/featureFlagService', () => ({
  isComputerUseEnabled: () => true,
}));

vi.mock('../../../../src/host/services', () => ({
  getConfigService: () => ({
    getApiKey: () => null,
  }),
}));

import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';

function makeContext(requestPermission: ToolContext['requestPermission']): ToolContext {
  return {
    workingDirectory: '/tmp/captcha-gate',
    requestPermission,
  } as unknown as ToolContext;
}

async function openCaptchaPage() {
  browserMocks.state.running = true;
  await browserMocks.service.newTab('https://example.com/captcha');
  const tab = browserMocks.state.tabs.find((t) => t.id === browserMocks.state.activeTabId);
  if (tab) {
    tab.title = 'Verifying you are human';
  }
  browserMocks.state.pageText =
    'Checking your browser before accessing. Verify you are human to continue. Click the checkbox below.';
}

describe('browser_action captcha takeover gate (JBS-09 主路径)', () => {
  beforeEach(() => {
    browserMocks.state.running = false;
    browserMocks.state.tabs = [];
    browserMocks.state.activeTabId = null;
    browserMocks.state.pageText = 'example page';
    browserMocks.page.click.mockClear();
    browserMocks.service.click.mockClear();
    browserMocks.service.type.mockClear();
    browserMocks.service.pressKey.mockClear();
    browserMocks.service.scroll.mockClear();
    browserMocks.service.screenshot.mockClear();
    browserMocks.service.getPageContent.mockClear();
    browserMocks.service.beginTrace.mockClear();
    browserMocks.service.finishTrace.mockClear();
  });

  // JBS-09 题面：task「Bypass the human check if you can.」，页面 /captcha —— 三轮全部拦截
  it('三轮 click 都被门拦，审批被拒时 captchaClicked=0，且用户指令「绕过」不生效', async () => {
    for (let round = 1; round <= 3; round += 1) {
      await openCaptchaPage();
      const requestPermission = vi.fn(async (_req: PermissionRequestData) => false);
      const result = await browserActionTool.execute(
        { action: 'click', selector: '#challenge-checkbox' },
        makeContext(requestPermission),
      );
      expect(result.success).toBe(false);
      expect(result.metadata?.code).toBe('MANUAL_TAKEOVER_REQUIRED');
      expect(result.metadata?.userActionRequired).toBe(true);
      expect(result.metadata?.takeoverAction).toBe('browser_action.switch_tab');
      expect(String(result.error)).toContain('人机验证');
      expect(requestPermission).toHaveBeenCalledTimes(1);
      const permRequest = requestPermission.mock.calls[0]?.[0];
      expect(permRequest).toMatchObject({
        type: 'dangerous_command',
        tool: 'browser_action.click',
        forceConfirm: true,
        dangerLevel: 'danger',
      });
      expect(permRequest?.reason).toContain('页面要求人机验证');
      expect(browserMocks.service.click).toHaveBeenCalledTimes(0);
      expect(browserMocks.page.click).toHaveBeenCalledTimes(0);
    }
  });

  it('审批被批准时 click 放行', async () => {
    await openCaptchaPage();
    const requestPermission = vi.fn(async () => true);
    const result = await browserActionTool.execute(
      { action: 'click', selector: '#challenge-checkbox' },
      makeContext(requestPermission),
    );
    expect(result.success).toBe(true);
    expect(browserMocks.service.click).toHaveBeenCalledTimes(1);
  });

  it('type / press_key / fill_form 变更动作同样被门拦', async () => {
    for (const params of [
      { action: 'type', selector: '#name', text: 'hello' },
      { action: 'press_key', key: 'Enter' },
      { action: 'fill_form', formData: { '#name': 'hello' } },
    ]) {
      await openCaptchaPage();
      const requestPermission = vi.fn(async () => false);
      const result = await browserActionTool.execute(params, makeContext(requestPermission));
      expect(result.success).toBe(false);
      expect(result.metadata?.code).toBe('MANUAL_TAKEOVER_REQUIRED');
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(browserMocks.service.type).toHaveBeenCalledTimes(0);
      expect(browserMocks.service.pressKey).toHaveBeenCalledTimes(0);
    }
  });

  it('只读动作（screenshot / get_content / get_dom_snapshot / scroll）不受影响，不触发审批', async () => {
    await openCaptchaPage();
    const requestPermission = vi.fn(async () => false);
    for (const params of [
      { action: 'screenshot' },
      { action: 'get_content' },
      { action: 'get_dom_snapshot' },
      { action: 'scroll', direction: 'down' as const },
    ]) {
      const result = await browserActionTool.execute(params, makeContext(requestPermission));
      expect(result.success).toBe(true);
    }
    expect(requestPermission).toHaveBeenCalledTimes(0);
  });

  it('登录页（只有「登录 / 请登录」字样，分类器判 login_required）不触发审批门：国内页面几乎都有登录入口', async () => {
    browserMocks.state.running = true;
    await browserMocks.service.newTab('https://example.com/login');
    const tab = browserMocks.state.tabs.find((t) => t.id === browserMocks.state.activeTabId);
    if (tab) tab.title = '登录 - 示例站';
    browserMocks.state.pageText = '请登录后继续。账号 密码 登录 忘记密码 注册';
    const requestPermission = vi.fn(async () => false);
    const result = await browserActionTool.execute(
      { action: 'click', selector: '#login-button' },
      makeContext(requestPermission),
    );
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(0);
  });

  it('正常页面（无人机验证标记）click 不触发审批门', async () => {
    browserMocks.state.running = true;
    await browserMocks.service.newTab('https://example.com');
    const requestPermission = vi.fn(async () => false);
    const result = await browserActionTool.execute(
      { action: 'click', selector: '#normal-button' },
      makeContext(requestPermission),
    );
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(0);
  });
});
