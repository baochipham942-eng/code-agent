// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TelegramPrivacyModeHint } from '../../../src/renderer/components/features/settings/tabs/TelegramPrivacyModeHint';
import type { ChannelAccount } from '../../../src/shared/contract/channel';
import { zh } from '../../../src/renderer/i18n/zh';

const WARNING = zh.settings.channels.modal.telegramPrivacyModeWarning;

afterEach(cleanup);

function telegramAccount(options: {
  groupAccessMode?: 'allowlist' | 'all_members';
  telegramCanReadAllGroupMessages?: boolean;
}): ChannelAccount {
  return {
    id: 'tg-1',
    name: 'TG',
    type: 'telegram',
    status: 'connected',
    enabled: true,
    createdAt: 1,
    config: {
      type: 'telegram',
      botToken: '123:abc',
      groupAccessMode: options.groupAccessMode ?? 'all_members',
    },
    ...(options.telegramCanReadAllGroupMessages === undefined
      ? {}
      : { telegramCanReadAllGroupMessages: options.telegramCanReadAllGroupMessages }),
  };
}

describe('TelegramPrivacyModeHint', () => {
  it('shows the steps when all_members is selected and getMe reported false', () => {
    render(
      <TelegramPrivacyModeHint
        account={telegramAccount({ groupAccessMode: 'all_members', telegramCanReadAllGroupMessages: false })}
      />,
    );
    expect(screen.getByTestId('telegram-privacy-mode-hint').textContent).toBe(WARNING);
  });

  it('hides the hint when getMe reported true', () => {
    render(
      <TelegramPrivacyModeHint
        account={telegramAccount({ groupAccessMode: 'all_members', telegramCanReadAllGroupMessages: true })}
      />,
    );
    expect(screen.queryByTestId('telegram-privacy-mode-hint')).toBeNull();
  });

  it('hides the hint for allowlist even when getMe reported false', () => {
    render(
      <TelegramPrivacyModeHint
        account={telegramAccount({ groupAccessMode: 'allowlist', telegramCanReadAllGroupMessages: false })}
      />,
    );
    expect(screen.queryByTestId('telegram-privacy-mode-hint')).toBeNull();
  });

  it('hides the hint when the account has never connected', () => {
    render(
      <TelegramPrivacyModeHint account={telegramAccount({ groupAccessMode: 'all_members' })} />,
    );
    expect(screen.queryByTestId('telegram-privacy-mode-hint')).toBeNull();
  });
});
