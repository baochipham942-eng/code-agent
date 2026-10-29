// @vitest-environment jsdom
// AppshotsSettings 快捷键权限行（FB-457）：启动 preflight 之后，输入监控的显式请求
// 只能从这一行的按钮发生。钉住四态（未授权 / 已授权已装 / 已授权需重启 / 命令缺失）
// 和「加载 tab 不得触发 request 命令」这条红线。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppshotsSettings } from '../../../src/renderer/components/features/settings/tabs/AppshotsSettings';
import ipcService from '../../../src/renderer/services/ipcService';

const facadeInvoke = vi.hoisted(() => vi.fn());
const openSettings = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../src/renderer/services/nativeCommandFacade', () => ({
  invokeNativeCommandAction: facadeInvoke,
  isNativeCommandRuntimeAvailable: () => true,
}));
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  openNativeDesktopSystemSettings: openSettings,
}));

interface HotkeyStatus {
  permissionGranted: boolean;
  tapInstalled: boolean;
  devChannel: boolean;
}

function mockHotkey(status: HotkeyStatus | Error): void {
  facadeInvoke.mockImplementation(async (action: string) => {
    if (action === 'getAppshotsHotkeyStatus') {
      if (status instanceof Error) throw status;
      return status;
    }
    if (action === 'requestAppshotsHotkeyAccess') {
      const devChannel = status instanceof Error ? false : status.devChannel;
      return { permissionGranted: true, tapInstalled: true, devChannel };
    }
    return undefined;
  });
}

function renderTab() {
  vi.mocked(ipcService.invokeDomain).mockResolvedValue({
    appshots: { enabled: true, targetSession: 'current' },
  } as never);
  return render(<AppshotsSettings />);
}

const REQUEST_COMMAND = 'requestAppshotsHotkeyAccess';

describe('AppshotsSettings 快捷键（⌘+⌘）输入监控权限行', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('not granted: 显示「未开启」+「开启快捷键」+「打开系统设置」两个入口', async () => {
    mockHotkey({ permissionGranted: false, tapInstalled: false, devChannel: true });
    renderTab();

    const row = await screen.findByTestId('appshots-hotkey-permission-row');
    expect(row.textContent).toContain('未开启');
    expect(screen.getByRole('button', { name: '开启快捷键' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开「输入监控」权限设置' })).toBeTruthy();
  });

  it('点击「开启快捷键」调用显式请求命令并刷新为已开启', async () => {
    mockHotkey({ permissionGranted: false, tapInstalled: false, devChannel: false });
    renderTab();
    await screen.findByTestId('appshots-hotkey-permission-row');

    fireEvent.click(screen.getByRole('button', { name: '开启快捷键' }));

    await waitFor(() => {
      expect(facadeInvoke).toHaveBeenCalledWith(REQUEST_COMMAND);
    });
    await waitFor(() => {
      expect(screen.getByTestId('appshots-hotkey-permission-row').textContent).toContain('已开启');
    });
  });

  it('granted + installed: 显示「已开启」，不再出现开启按钮', async () => {
    mockHotkey({ permissionGranted: true, tapInstalled: true, devChannel: false });
    renderTab();

    const row = await screen.findByTestId('appshots-hotkey-permission-row');
    expect(row.textContent).toContain('已开启');
    expect(screen.queryByRole('button', { name: '开启快捷键' })).toBeNull();
  });

  it('granted but not installed: 显示「已授权，重启 Neo 后生效」', async () => {
    mockHotkey({ permissionGranted: true, tapInstalled: false, devChannel: true });
    renderTab();

    const row = await screen.findByTestId('appshots-hotkey-permission-row');
    expect(row.textContent).toContain('已授权，重启 Neo 后生效');
    expect(screen.queryByRole('button', { name: '开启快捷键' })).toBeNull();
  });

  it('status 命令缺失（老 shell）：整行隐藏且不发请求', async () => {
    mockHotkey(new Error('command appshots_hotkey_status not found'));
    renderTab();

    await waitFor(() => {
      expect(facadeInvoke.mock.calls.some((call) => call[0] === 'getAppshotsHotkeyStatus')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('appshots-hotkey-permission-row')).toBeNull();
    });
    expect(facadeInvoke.mock.calls.some((call) => call[0] === REQUEST_COMMAND)).toBe(false);
  });

  it('加载 tab 只查状态，绝不触发 request 命令（FB-457 红线）', async () => {
    mockHotkey({ permissionGranted: false, tapInstalled: false, devChannel: true });
    renderTab();

    await screen.findByTestId('appshots-hotkey-permission-row');
    // 等 settings 加载副作用（syncNativeEnabled）也走完，避免误判「还没来得及调」
    await waitFor(() => {
      expect(ipcService.invokeDomain).toHaveBeenCalled();
    });
    expect(facadeInvoke.mock.calls.some((call) => call[0] === REQUEST_COMMAND)).toBe(false);
  });
});
