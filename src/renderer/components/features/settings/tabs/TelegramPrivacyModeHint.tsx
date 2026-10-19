import React from 'react';
import type { ChannelAccount } from '@shared/contract/channel';
import { useI18n } from '../../../../hooks/useI18n';

function showsTelegramPrivacyModeHint(account: ChannelAccount): boolean {
  if (account.type !== 'telegram' || account.config.type !== 'telegram') return false;
  return account.config.groupAccessMode === 'all_members'
    && account.telegramCanReadAllGroupMessages === false;
}

/** Account-row warning. Unknown (never connected) and a true getMe result render nothing. */
export function TelegramPrivacyModeHint({ account }: { account: ChannelAccount }): React.ReactElement | null {
  const { t } = useI18n();
  if (!showsTelegramPrivacyModeHint(account)) return null;
  return (
    <div className="mt-1 text-xs text-badge-warning" data-testid="telegram-privacy-mode-hint">
      {t.settings.channels.modal.telegramPrivacyModeWarning}
    </div>
  );
}

/** One-line prerequisite under the group-access select, only while all_members is chosen. */
export function TelegramGroupAccessPrerequisite({
  mode,
}: {
  mode: 'allowlist' | 'all_members';
}): React.ReactElement | null {
  const { t } = useI18n();
  if (mode !== 'all_members') return null;
  return (
    <p className="mt-1 text-xs text-zinc-500" data-testid="telegram-privacy-mode-prerequisite">
      {t.settings.channels.modal.groupAccessModePrivacyPrerequisite}
    </p>
  );
}
