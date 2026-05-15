import { describe, expect, it } from 'vitest';
import type {
  ChannelAccount,
  FeishuChannelConfig,
  HttpApiChannelConfig,
  TelegramChannelConfig,
} from '../../../src/shared/contract/channel';
import {
  filterChannelAccounts,
  getChannelConfigSummary,
  getChannelStatusSummary,
  getChannelTypeLabel,
  type ChannelTypeInfo,
} from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';

const channelTypes: ChannelTypeInfo[] = [
  { type: 'http-api', name: 'HTTP API' },
  { type: 'feishu', name: '飞书' },
  { type: 'telegram', name: 'Telegram' },
];

const accounts: ChannelAccount[] = [
  {
    id: 'api-local',
    name: '本地 API',
    type: 'http-api',
    status: 'connected',
    enabled: true,
    createdAt: 1,
    config: {
      type: 'http-api',
      port: 8080,
      apiKey: 'secret-key',
    } satisfies HttpApiChannelConfig,
  },
  {
    id: 'feishu-work',
    name: '工作飞书',
    type: 'feishu',
    status: 'error',
    errorMessage: 'token expired',
    enabled: true,
    createdAt: 2,
    config: {
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      webhookPort: 3201,
    } satisfies FeishuChannelConfig,
  },
  {
    id: 'tg-home',
    name: 'Telegram 家用',
    type: 'telegram',
    status: 'disconnected',
    enabled: false,
    createdAt: 3,
    config: {
      type: 'telegram',
      botToken: 'bot-token',
      allowedUserIds: [1, 2],
    } satisfies TelegramChannelConfig,
  },
];

describe('ChannelsSettings management helpers', () => {
  it('summarizes channel account states for the management surface', () => {
    expect(getChannelStatusSummary(accounts)).toEqual({
      total: 3,
      connected: 1,
      connecting: 0,
      error: 1,
      disconnected: 1,
    });
  });

  it('filters accounts by status, name and type label', () => {
    expect(filterChannelAccounts({
      accounts,
      channelTypes,
      statusFilter: 'error',
      query: '',
    }).map((account) => account.id)).toEqual(['feishu-work']);

    expect(filterChannelAccounts({
      accounts,
      channelTypes,
      statusFilter: 'all',
      query: 'telegram',
    }).map((account) => account.id)).toEqual(['tg-home']);

    expect(filterChannelAccounts({
      accounts,
      channelTypes,
      statusFilter: 'connected',
      query: 'api',
    }).map((account) => account.id)).toEqual(['api-local']);
  });

  it('keeps compact config summaries stable for table rows', () => {
    expect(getChannelTypeLabel('feishu', channelTypes)).toBe('飞书');
    expect(getChannelConfigSummary(accounts[0])).toBe('端口 8080');
    expect(getChannelConfigSummary(accounts[1])).toBe('Webhook 3201');
    expect(getChannelConfigSummary(accounts[2])).toBe('2 个白名单用户');
  });
});
