// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain,
    on: () => undefined,
    off: () => undefined,
  },
  ipcService: {
    invokeDomain,
    on: () => undefined,
    off: () => undefined,
  },
}));

import { BrowserSurfaceContent } from '../../../src/renderer/components/features/browser/BrowserSurfaceContent';

const NO_PROFILE_SENTENCE = '未发现可用 Chromium profile';
const PERMISSION_COPY = '系统未授权 Neo 读取 Google Chrome 数据（系统设置 › 隐私与安全性 › 完全磁盘访问）';
const RELAY_HINT = '或改用 Chrome Relay';

function deniedChrome() {
  return {
    source: 'chrome',
    appName: 'Google Chrome',
    profileId: 'Default',
    profileName: 'Default',
    profileDir: '/Library/Application Support/Google/Chrome',
    available: false,
    unavailableReason: 'permission_denied',
    unavailableMessage: 'Permission denied reading /Library/Application Support/Google/Chrome (EPERM)',
  };
}

function availableArc() {
  return {
    source: 'arc',
    appName: 'Arc',
    profileId: 'Default',
    profileName: 'Arc Person',
    profileDir: '/Library/Application Support/Arc/User Data/Default',
    available: true,
    unavailableReason: null,
    unavailableMessage: null,
    cookieDomains: [],
  };
}

let listed: unknown[] = [];

beforeEach(() => {
  listed = [];
  invokeDomain.mockReset();
  invokeDomain.mockImplementation(async (_domain: string, action: string) => {
    if (action === 'listBrowserProfiles') return listed;
    if (action === 'getManagedBrowserSession') {
      return { running: false, mode: 'headless', activeTab: null, tabCount: 0 };
    }
    return true;
  });
});

afterEach(() => {
  cleanup();
});

async function renderLoadedPanel(): Promise<void> {
  render(React.createElement(BrowserSurfaceContent));
  await waitFor(() => {
    expect(screen.getByText(PERMISSION_COPY)).toBeTruthy();
  });
  expect(screen.getByRole('button', { name: '打开系统设置' })).toBeTruthy();
  expect(screen.getByText(RELAY_HINT)).toBeTruthy();
  expect(screen.queryByText(new RegExp(NO_PROFILE_SENTENCE))).toBeNull();
}

describe('BrowserSurfaceContent permission_denied notice', () => {
  it('shows the notice and settings button when every source is permission_denied', async () => {
    listed = [deniedChrome()];
    await renderLoadedPanel();
    fireEvent.click(screen.getByRole('button', { name: '打开系统设置' }));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.DESKTOP, 'openFullDiskAccessSettings');
    });
  });

  it('shows the notice above a mixed list that still includes an available Arc profile', async () => {
    listed = [deniedChrome(), availableArc()];
    await renderLoadedPanel();
    expect(screen.getByText(/Arc Person/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开系统设置' }));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.DESKTOP, 'openFullDiskAccessSettings');
    });
  });
});
