// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const webMode = vi.hoisted(() => ({ value: false }));
const invoke = vi.hoisted(() => vi.fn());
const statusListeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke,
    on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
      statusListeners.set(channel, handler);
      return () => {};
    }),
    invokeDomain: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/utils/platform')>()),
  isWebMode: () => webMode.value,
}));
vi.mock('../../../src/renderer/components/features/settings/sections/CompanionSection', () => ({
  CompanionSection: () => null,
}));

import { ChannelsSettings } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const accounts = [
  {
    id: 'tg-1',
    name: 'TG 机器人',
    type: 'telegram',
    status: 'connected',
    enabled: true,
    createdAt: 1,
    telegramCanReadAllGroupMessages: false,
    config: { type: 'telegram', botToken: '123:abc', groupAccessMode: 'all_members' },
  },
];
const types = [{ type: 'telegram', name: 'Telegram' }];

beforeEach(() => {
  webMode.value = false;
  invoke.mockImplementation(async (channel: string) =>
    String(channel).toLowerCase().includes('types') ? types : accounts);
});
afterEach(() => {
  cleanup();
  statusListeners.clear();
  useAppStore.setState({ language: 'zh' });
  invoke.mockReset();
});

describe('ChannelsSettings telegram privacy hint vs disconnect', () => {
  it('disconnect 更新状态后警告随之消失，且不触发列表重载', async () => {
    useAppStore.setState({ language: 'zh' });
    const c = zh.settings.channels;
    render(<ChannelsSettings />);

    await screen.findByText('TG 机器人');
    const row = screen.getByText('TG 机器人').closest('div.grid') as HTMLElement;
    expect(within(row).getByTestId('telegram-privacy-mode-hint').textContent).toBe(
      c.modal.telegramPrivacyModeWarning,
    );

    invoke.mockClear();
    fireEvent.click(screen.getByRole('button', { name: c.actions.disconnect }));
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.CHANNEL_DISCONNECT_ACCOUNT, 'tg-1');
    });
    const callsAfterDisconnect = invoke.mock.calls.length;

    // 模拟 host 的 CHANNEL_ACCOUNT_STATUS_CHANGED 推送（getMe 旧值仍在账号上）
    const fire = statusListeners.get(IPC_CHANNELS.CHANNEL_ACCOUNT_STATUS_CHANGED);
    expect(fire).toBeTruthy();
    await act(async () => {
      fire?.({ accountId: 'tg-1', status: 'disconnected', error: undefined });
    });

    await within(row).findByText(
      c.statusFilters.find((f) => f.value === 'disconnected')?.label ?? 'disconnected',
    );
    expect(within(row).queryByTestId('telegram-privacy-mode-hint')).toBeNull();
    // 状态更新只来自事件推送，没有列表重载等额外 IPC
    expect(invoke.mock.calls.length).toBe(callsAfterDisconnect);
  });
});
