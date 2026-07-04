import { describe, expect, it } from 'vitest';
import type {
  ChannelAccount,
  FeishuChannelConfig,
  HttpApiChannelConfig,
  LarkChannelConfig,
  TelegramChannelConfig,
} from '../../../src/shared/contract/channel';
import {
  CHANNEL_PRIVACY_MODE_OPTIONS,
  filterChannelAccounts,
  getChannelConfigSummary,
  getChannelPrivacyModeCopy,
  getChannelStatusSummary,
  getChannelTypeLabel,
  type ChannelTypeInfo,
} from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const channelsText = zh.settings.channels;

const channelTypes: ChannelTypeInfo[] = [
  { type: 'http-api', name: 'HTTP API' },
  { type: 'feishu', name: '飞书' },
  { type: 'lark', name: 'Lark' },
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
  {
    id: 'lark-global',
    name: '海外 Lark',
    type: 'lark',
    status: 'connected',
    enabled: true,
    createdAt: 4,
    config: {
      type: 'lark',
      appId: 'cli_lark',
      appSecret: 'secret',
      webhookPort: 3301,
    } satisfies LarkChannelConfig,
  },
];

describe('ChannelsSettings management helpers', () => {
  it('summarizes channel account states for the management surface', () => {
    expect(getChannelStatusSummary(accounts)).toEqual({
      total: 4,
      connected: 2,
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

    expect(filterChannelAccounts({
      accounts,
      channelTypes,
      statusFilter: 'all',
      query: 'lark',
    }).map((account) => account.id)).toEqual(['lark-global']);
  });

  it('keeps compact config summaries stable for table rows', () => {
    expect(getChannelTypeLabel('feishu', channelTypes)).toBe('飞书');
    expect(getChannelConfigSummary(accounts[0])).toBe(`${channelsText.configSummary.portPrefix}8080`);
    expect(getChannelConfigSummary(accounts[1])).toBe('Webhook 3201');
    expect(getChannelConfigSummary(accounts[2])).toBe(`2${channelsText.configSummary.allowlistUserSuffix}`);
    expect(getChannelTypeLabel('lark', channelTypes)).toBe('Lark');
    expect(getChannelConfigSummary(accounts[3])).toBe('Webhook 3301');
  });

  it('uses readable privacy copy instead of raw enum labels', () => {
    expect(CHANNEL_PRIVACY_MODE_OPTIONS.map((option) => option.label)).toEqual(
      channelsText.privacyModes.map((option) => option.label),
    );
    expect(getChannelPrivacyModeCopy('local-redact').description).toBe(channelsText.privacyModes[0]!.description);
    expect(getChannelPrivacyModeCopy('allow-raw').description).toBe(channelsText.privacyModes[1]!.description);
    expect(getChannelPrivacyModeCopy('off').description).toBe(channelsText.privacyModes[2]!.description);
  });

  it('channels i18n arrays keep zh/en data-field value sequences aligned', () => {
    expect(en.settings.channels.statusFilters.map((option) => option.value)).toEqual(
      channelsText.statusFilters.map((option) => option.value),
    );
    expect(en.settings.channels.privacyModes.map((option) => option.value)).toEqual(
      channelsText.privacyModes.map((option) => option.value),
    );
  });
});
