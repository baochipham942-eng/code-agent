// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { getAppshotErrorMessage } from '../../../src/renderer/utils/appshotError';

const state = vi.hoisted(() => ({
  language: 'en',
  lastApp: { pid: 412, bundleId: 'com.apple.TextEdit', appName: 'TextEdit', alive: true } as {
    pid: number; bundleId: string; appName: string; alive: boolean;
    attachable?: boolean; reasonCode?: 'app_closed' | 'finder_desktop' | null;
  } | null,
  nativeInvoke: vi.fn(),
  settings: vi.fn(),
  permissions: vi.fn(),
  openSettingsTab: vi.fn(),
}));
vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({ skills: [], connectors: [], mcpServers: [], items: [] }),
}));
vi.mock('../../../src/renderer/stores/agentRegistryStore', () => ({
  useAgentRegistryStore: (selector: (value: { entries: [] }) => unknown) => selector({ entries: [] }),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (value: Record<string, unknown>) => unknown) => selector({
    activeAgentId: null, setActiveAgentId: vi.fn(), openCapabilityHub: vi.fn(),
    openSettingsTab: state.openSettingsTab,
  }),
}));
vi.mock('../../../src/renderer/stores/teamRecipeStore', () => ({
  useTeamRecipeStore: (selector: (value: Record<string, unknown>) => unknown) => selector({
    recipes: [], isLoaded: true, refresh: vi.fn(),
  }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: state.settings },
}));
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  getNativeDesktopPermissionStatus: state.permissions,
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: state.language === 'en' ? en : zh }),
}));
import { InputAddMenu } from '../../../src/renderer/components/features/chat/ChatInput/InputAddMenu';

beforeEach(() => {
  vi.clearAllMocks();
  state.language = 'en';
  state.lastApp = { pid: 412, bundleId: 'com.apple.TextEdit', appName: 'TextEdit', alive: true };
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke: state.nativeInvoke },
  });
  state.nativeInvoke.mockImplementation(async (command: string) => (
    command === 'appshots_last_front_app' ? state.lastApp : undefined
  ));
  state.settings.mockResolvedValue({ appshots: { enabled: true, targetSession: 'current' } });
  state.permissions.mockResolvedValue({ permissions: [
    { kind: 'screenCapture', status: 'granted' },
    { kind: 'accessibility', status: 'granted' },
  ] });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

async function openMenu(name = 'More input options') {
  render(<InputAddMenu onFileSelect={vi.fn()} onSelectCapability={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name }));
  await waitFor(() => expect(state.nativeInvoke).toHaveBeenCalledWith('appshots_last_front_app', undefined));
}

describe('composer attach last front app', () => {
  it('uses the real app name and places the entry directly after upload', async () => {
    await openMenu();
    const attach = await screen.findByRole('button', { name: 'Attach TextEdit' });
    expect((attach as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Upload images or files' }).nextElementSibling).toBe(attach);
  });

  it('uses the Chinese attach label with the same real app name', async () => {
    state.language = 'zh';
    await openMenu('更多输入选项');
    expect(await screen.findByRole('button', { name: '附加 TextEdit' })).toBeTruthy();
  });

  it('disables the entry with a reason when there is no last app', async () => {
    state.lastApp = null;
    await openMenu();
    const attach = await screen.findByRole('button', { name: /Attach last app/ });
    expect((attach as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('No recently used app')).toBeTruthy();
    fireEvent.click(attach);
    expect(state.nativeInvoke).not.toHaveBeenCalledWith('appshots_trigger_for_pid', expect.anything());
  });

  it('disables the entry with a named reason when alive is false', async () => {
    state.lastApp!.alive = false;
    await openMenu();
    const attach = await screen.findByRole('button', { name: /Attach TextEdit/ });
    expect((attach as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('TextEdit is no longer open')).toBeTruthy();
    fireEvent.click(attach);
    expect(state.nativeInvoke).not.toHaveBeenCalledWith('appshots_trigger_for_pid', expect.anything());
  });

  it('disables Finder with the desktop reason', async () => {
    state.language = 'zh';
    state.lastApp = {
      pid: 412,
      bundleId: 'com.apple.finder',
      appName: 'Finder',
      alive: true,
      attachable: false,
      reasonCode: 'finder_desktop',
    };
    await openMenu('更多输入选项');
    const attach = await screen.findByRole('button', { name: '附加 Finder' });
    expect((attach as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('桌面无可附加窗口')).toBeTruthy();
    fireEvent.click(attach);
    expect(state.nativeInvoke).not.toHaveBeenCalledWith('appshots_trigger_for_pid', expect.anything());
  });

  it('maps the closed-app error reason code to the Chinese toast text', () => {
    expect(getAppshotErrorMessage({
      code: 'no_target',
      reasonCode: 'app_closed',
      appName: 'TextEdit',
      message: '',
    }, zh)).toBe('Appshot 失败：TextEdit 已关闭');
  });

  it('invokes the pid command and closes the menu without touching the chip', async () => {
    await openMenu();
    fireEvent.click(await screen.findByRole('button', { name: 'Attach TextEdit' }));
    await waitFor(() => expect(state.nativeInvoke).toHaveBeenCalledWith('appshots_trigger_for_pid', { pid: 412 }));
    expect(screen.queryByRole('button', { name: 'Attach TextEdit' })).toBeNull();
    expect(state.openSettingsTab).not.toHaveBeenCalled();
  });

  it('routes disabled Appshots into its existing settings enable flow without capturing', async () => {
    state.settings.mockResolvedValue({ appshots: { enabled: false, targetSession: 'current' } });
    await openMenu();
    fireEvent.click(await screen.findByRole('button', { name: 'Attach TextEdit' }));
    await waitFor(() => expect(state.openSettingsTab).toHaveBeenCalledWith('appshots'));
    expect(state.nativeInvoke).not.toHaveBeenCalledWith('appshots_trigger_for_pid', expect.anything());
    expect(state.permissions).not.toHaveBeenCalled();
  });

  it.each(['screenCapture', 'accessibility'])('routes missing %s permission to the same settings guidance', async (kind) => {
    state.permissions.mockResolvedValue({ permissions: [
      { kind: 'screenCapture', status: kind === 'screenCapture' ? 'denied' : 'granted' },
      { kind: 'accessibility', status: kind === 'accessibility' ? 'denied' : 'granted' },
    ] });
    await openMenu();
    fireEvent.click(await screen.findByRole('button', { name: 'Attach TextEdit' }));
    await waitFor(() => expect(state.openSettingsTab).toHaveBeenCalledWith('appshots'));
    expect(state.nativeInvoke).not.toHaveBeenCalledWith('appshots_trigger_for_pid', expect.anything());
  });

  it('refreshes the last app every time the existing menu opens', async () => {
    await openMenu();
    await screen.findByRole('button', { name: 'Attach TextEdit' });
    fireEvent.click(screen.getByRole('button', { name: 'More input options' }));
    state.lastApp = { pid: 418, bundleId: 'com.apple.Safari', appName: 'Safari', alive: true };
    fireEvent.click(screen.getByRole('button', { name: 'More input options' }));
    expect(await screen.findByRole('button', { name: 'Attach Safari' })).toBeTruthy();
    expect(state.nativeInvoke.mock.calls.filter(([command]) => command === 'appshots_last_front_app')).toHaveLength(2);
  });
});
