// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import type { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';
import type { LiveAgentPointerState } from '../../../src/renderer/hooks/useLiveAgentPointer';
import type { SurfaceLiveFrameStreamState } from '../../../src/renderer/hooks/useSurfaceLiveFrames';

type BrowserSessionState = ReturnType<typeof useWorkbenchBrowserSession>;

const listImportableBrowserProfiles = vi.fn(async () => ([
  {
    source: 'chrome' as const,
    profileId: 'Default',
    profileName: 'Person 1',
    appName: 'Google Chrome',
    available: true,
    cookieDbPath: '/tmp/Cookies',
  },
]));
const importBrowserProfileCookiesToPersonal = vi.fn(async (_args: {
  source: 'chrome';
  profileId: string;
}) => ({
  ok: true as boolean,
  source: 'chrome' as const,
  profileId: 'Default',
  importedCookieCount: 3,
  skippedCookieCount: 0,
  expiredSkippedCount: 0,
  domainCount: 2,
  domains: ['example.com', 'github.com'],
  accountState: null as null,
  warnings: [] as string[],
  durationMs: 12,
  failureCode: null as string | null,
  failureMessage: null as string | null,
  importSource: { kind: 'browser-profile-cookies' as const, source: 'chrome' as const, profileId: 'Default' },
}));

let browserSessionState: BrowserSessionState;
let pointerState: LiveAgentPointerState;
let liveFrameState: SurfaceLiveFrameStreamState;

vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => browserSessionState,
}));
vi.mock('../../../src/renderer/hooks/useLiveAgentPointer', () => ({
  useLiveAgentPointer: () => pointerState,
}));
vi.mock('../../../src/renderer/hooks/useSurfaceLiveFrames', () => ({
  useSurfaceLiveFrames: () => liveFrameState,
}));
vi.mock('../../../src/renderer/services/userBrowserLink', () => ({
  openHttpLinkInRailAsync: vi.fn(async () => ({
    conversationId: 'session-a',
    runId: 'run-a',
    surfaceSessionId: 'surface-user',
    snapshot: { version: 1, conversationId: 'session-a', sessions: [], updatedAt: 1 },
  })),
  closeUserBrowserLinkRun: vi.fn(async () => undefined),
  controlUserBrowserHistory: vi.fn(async () => null),
  dispatchUserBrowserInput: vi.fn(async () => null),
  setUserBrowserViewport: vi.fn(async () => null),
}));
vi.mock('../../../src/renderer/services/browserCookieImportClient', () => ({
  listImportableBrowserProfiles: () => listImportableBrowserProfiles(),
  importBrowserProfileCookiesToPersonal: (args: {
    source: 'chrome';
    profileId: string;
  }) => importBrowserProfileCookiesToPersonal(args),
}));

function buildBrowserSessionState(overrides: Partial<BrowserSessionState> = {}): BrowserSessionState {
  return {
    mode: 'managed',
    managedSession: {
      running: true,
      tabCount: 1,
      activeTab: {
        id: 'tab-1',
        url: 'https://example.com',
        title: 'Example',
        canGoBack: false,
        canGoForward: false,
      },
    },
    computerSurface: null,
    preview: null,
    readinessItems: [],
    blocked: false,
    repairActions: [],
    busyActionKind: null,
    actionError: null,
    ownedByCurrentSession: true,
    browserSurfaceSessionId: 'surface-user',
    browserSurfaceTitle: 'Example',
    browserSurfaceOrigin: 'https://example.com',
    refresh: async () => undefined,
    probePermissions: async () => undefined,
    runRepairAction: async () => undefined,
    ...overrides,
  } as BrowserSessionState;
}

describe('BrowserAgentWindow Cookie 导入入口（P1）', () => {
  beforeEach(() => {
    listImportableBrowserProfiles.mockClear();
    importBrowserProfileCookiesToPersonal.mockClear();
    useAppStore.setState({
      language: 'zh',
      showLocalOpsPanel: false,
      localOpsTab: 'desktop',
      activeWorkbenchTab: 'browser',
      workbenchCollapsed: false,
    });
    useSessionStore.setState({ currentSessionId: 'session-a' } as never);
    pointerState = { event: null, lastEvent: null, isLive: false, timeline: [] };
    liveFrameState = { frame: null, streaming: false, unavailableReason: null };
    browserSessionState = buildBrowserSessionState();
  });

  afterEach(() => cleanup());

  it('⋯ 菜单露出「导入 Cookie…」，确认后带 userConfirmed 导入个人档案', async () => {
    render(<BrowserAgentWindow />);
    fireEvent.click(screen.getByTestId('browser-agent-window-more'));
    fireEvent.click(screen.getByTestId('browser-agent-window-import-cookies'));

    await waitFor(() => {
      expect(listImportableBrowserProfiles).toHaveBeenCalled();
      expect(screen.getByTestId('browser-agent-window-import-cookies-dialog')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('确认导入'));
    await waitFor(() => {
      expect(importBrowserProfileCookiesToPersonal).toHaveBeenCalledWith({
        source: 'chrome',
        profileId: 'Default',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('browser-agent-window-cookie-import-notice').textContent)
        .toContain('已导入 3 条 Cookie');
    });
  });

  it('Chrome 锁库失败展示人话提示', async () => {
    importBrowserProfileCookiesToPersonal.mockResolvedValueOnce({
      ok: false,
      source: 'chrome' as const,
      profileId: 'Default',
      importedCookieCount: 0,
      skippedCookieCount: 0,
      expiredSkippedCount: 0,
      domainCount: 0,
      domains: [],
      accountState: null,
      failureCode: 'cookie_db_copy_failed',
      failureMessage: 'Failed to snapshot Cookies DB (is the browser open?): EBUSY',
      warnings: [],
      durationMs: 4,
      importSource: { kind: 'browser-profile-cookies' as const, source: 'chrome' as const, profileId: 'Default' },
    });
    render(<BrowserAgentWindow />);
    fireEvent.click(screen.getByTestId('browser-agent-window-more'));
    fireEvent.click(screen.getByTestId('browser-agent-window-import-cookies'));
    await waitFor(() => expect(screen.getByTestId('browser-agent-window-import-cookies-dialog')).toBeTruthy());
    fireEvent.click(screen.getByText('确认导入'));
    await waitFor(() => {
      expect(screen.getByTestId('browser-cookie-import-error').textContent)
        .toContain('Cookie 数据库被占用');
    });
  });
});
