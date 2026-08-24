// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAccount } from '../../../src/shared/contract/channel';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));

import {
  CronResultChannelField,
  CronResultChannelSummary,
} from '../../../src/renderer/components/features/cron/CronResultChannel';

const feishuAccount: ChannelAccount = {
  id: 'account-feishu',
  name: '工作飞书',
  type: 'feishu',
  config: { type: 'feishu', appId: 'app-id', appSecret: 'app-secret' },
  status: 'connected',
  enabled: true,
  createdAt: 1,
};

const telegramAccount: ChannelAccount = {
  id: 'account-telegram',
  name: '家用 bot',
  type: 'telegram',
  config: { type: 'telegram', botToken: 'token' },
  status: 'connected',
  enabled: true,
  createdAt: 1,
};

function mockCatalog(accounts: ChannelAccount[]): void {
  ipc.invoke.mockImplementation(async (channel: string, accountId?: string) => {
    if (channel === IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS) return accounts;
    if (channel === IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS && accountId === feishuAccount.id) {
      return {
        supported: true,
        conversations: [{ id: 'oc_group', name: '林晨, 苏三' }],
      };
    }
    if (channel === IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS && accountId === telegramAccount.id) {
      return { supported: false, conversations: [] };
    }
    throw new Error(`Unexpected IPC: ${channel}`);
  });
}

const ControlledField: React.FC<{ initialValue?: string }> = ({ initialValue = '' }) => {
  const [value, setValue] = useState(initialValue);
  return (
    <>
      <CronResultChannelField value={value} onChange={setValue} />
      <output data-testid="result-channel-value">{value}</output>
    </>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  ipc.on.mockReturnValue(() => undefined);
});

afterEach(cleanup);

describe('CronResultChannelField', () => {
  it('有账号时按“账号 → 会话”选择，并产出账号名加会话 ID 的完整目标', async () => {
    mockCatalog([feishuAccount]);
    render(<ControlledField />);

    const accountSelect = await screen.findByLabelText('结果推送到（可选）');
    fireEvent.change(accountSelect, { target: { value: feishuAccount.id } });
    const conversationSelect = await screen.findByLabelText('选择接收会话');
    fireEvent.change(conversationSelect, { target: { value: 'oc_group' } });

    expect(screen.getByTestId('result-channel-value').textContent).toBe('工作飞书:oc_group');
  });

  it('一个账号都没配时给出连接入口，不用空下拉阻塞创建', async () => {
    mockCatalog([]);
    render(<ControlledField />);

    expect(await screen.findByText(/还没有连接消息通道/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '去连接一个' })).toBeTruthy();
  });

  it('不支持列会话的通道退化为手填，并仍拼出完整目标', async () => {
    mockCatalog([telegramAccount]);
    render(<ControlledField />);

    fireEvent.change(await screen.findByLabelText('结果推送到（可选）'), {
      target: { value: telegramAccount.id },
    });
    const input = await screen.findByLabelText('接收会话 ID');
    fireEvent.change(input, { target: { value: '-10001' } });

    expect(screen.getByText(/该通道不能自动列出会话/)).toBeTruthy();
    expect(screen.getByTestId('result-channel-value').textContent).toBe('家用 bot:-10001');
  });

  it('账号已删时显示原值和不可用提示，不静默清空', async () => {
    mockCatalog([]);
    render(<ControlledField initialValue="旧飞书:oc_deleted" />);

    await waitFor(() => expect(screen.getByTestId('cron-result-channel-account-unavailable')).toBeTruthy());
    expect((screen.getByLabelText('结果推送到（可选）') as HTMLSelectElement).value).toBe('__unavailable__');
    expect(screen.getByTestId('result-channel-value').textContent).toBe('旧飞书:oc_deleted');
  });
});

describe('CronResultChannelSummary', () => {
  it('未配置显示不推送，账号已删则保留原值并显式警告', async () => {
    mockCatalog([]);
    const { rerender } = render(<CronResultChannelSummary />);
    expect(screen.getByTestId('cron-result-channel-summary').textContent).toContain('不推送');

    rerender(<CronResultChannelSummary value="旧飞书:oc_deleted" />);
    await waitFor(() => {
      const summary = screen.getByTestId('cron-result-channel-summary');
      expect(summary.textContent).toContain('旧飞书:oc_deleted');
      expect(summary.textContent).toContain('通道已不可用');
    });
  });
});
