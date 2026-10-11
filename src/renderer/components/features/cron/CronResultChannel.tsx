import React, { useEffect, useMemo, useState } from 'react';
import type { ChannelAccount } from '@shared/contract/channel';
import { Button } from '../../primitives/Button';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { useChannelCatalog } from './useChannelCatalog';

function parseResultTarget(value: string): { accountKey: string; conversationId: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const accountKey = value.slice(0, separator).trim();
  const conversationId = value.slice(separator + 1).trim();
  return accountKey && conversationId ? { accountKey, conversationId } : null;
}

function findTargetAccount(accounts: ChannelAccount[], accountKey: string): ChannelAccount | undefined {
  return accounts.find((account) => account.type === accountKey || account.name === accountKey);
}

function buildResultTarget(account: ChannelAccount, conversationId: string): string {
  const destination = conversationId.trim();
  return destination ? `${account.name}:${destination}` : '';
}

interface CronResultChannelFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export const CronResultChannelField: React.FC<CronResultChannelFieldProps> = ({ value, onChange }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const { accounts, accountsLoading, conversationsByAccount } = useChannelCatalog();
  const parsedTarget = useMemo(() => parseResultTarget(value), [value]);
  const savedAccount = parsedTarget
    ? findTargetAccount(accounts, parsedTarget.accountKey)
    : undefined;
  const [selectedAccountId, setSelectedAccountId] = useState('');

  useEffect(() => {
    if (savedAccount) {
      setSelectedAccountId(savedAccount.id);
    } else if (selectedAccountId && !accounts.some((account) => account.id === selectedAccountId)) {
      setSelectedAccountId('');
    }
  }, [accounts, savedAccount, selectedAccountId]);

  const staleAccount = Boolean(value && !accountsLoading && !savedAccount);
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const conversationState = selectedAccount ? conversationsByAccount[selectedAccount.id] : undefined;
  const currentConversationId = savedAccount?.id === selectedAccount?.id
    ? parsedTarget?.conversationId || ''
    : '';

  const handleAccountChange = (accountId: string) => {
    if (accountId === '__unavailable__') return;
    setSelectedAccountId(accountId);
    onChange('');
  };

  const accountOptions = [
    ...(staleAccount ? [{ value: '__unavailable__', label: value }] : []),
    { value: '', label: cc.resultPushNoneDefault },
    ...accounts.map((account) => ({
      value: account.id,
      // 账号名是用户自己起的（「工作飞书」已经说明是哪个通道）。🚫 不要把内部类型串
      // （feishu / lark / http-api）当界面文案拼进去——Neo 的用户默认是非程序员协作者。
      label: account.name,
    })),
  ];

  const savedConversationExists = Boolean(
    currentConversationId
    && conversationState?.conversations.some((conversation) => conversation.id === currentConversationId),
  );

  return (
    <div data-testid="cron-result-channel-field">
      <label className="mb-1 block text-sm text-zinc-400" htmlFor="cron-result-channel-account">
        {cc.resultPushLabel}
      </label>
      <Select
        id="cron-result-channel-account"
        value={staleAccount ? '__unavailable__' : selectedAccountId}
        options={accountOptions}
        onChange={(event) => handleAccountChange(event.target.value)}
        disabled={accountsLoading}
      />

      {accountsLoading && <p className="mt-1 text-xs text-zinc-500">{cc.resultPushLoading}</p>}

      {!accountsLoading && accounts.length === 0 && !staleAccount && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>{cc.resultPushNoAccounts}</span>
          <Button size="sm" variant="ghost" onClick={() => openSettingsTab('channels')}>
            {cc.resultPushConnect}
          </Button>
        </div>
      )}

      {staleAccount && (
        <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-badge-warning" data-testid="cron-result-channel-account-unavailable">
          {cc.resultPushAccountUnavailable.replace('{value}', value)}
        </div>
      )}

      {selectedAccount && conversationState?.loading && (
        <p className="mt-2 text-xs text-zinc-500">{cc.resultPushLoading}</p>
      )}

      {selectedAccount && conversationState && !conversationState.loading && conversationState.supported && !conversationState.error && (
        conversationState.conversations.length > 0 || currentConversationId ? (
          <div className="mt-2">
            <Select
              aria-label={cc.resultPushChooseConversation}
              value={currentConversationId}
              options={[
                { value: '', label: cc.resultPushChooseConversation, disabled: true },
                ...(!savedConversationExists && currentConversationId
                  ? [{ value: currentConversationId, label: currentConversationId }]
                  : []),
                ...conversationState.conversations.map((conversation) => ({
                  value: conversation.id,
                  label: conversation.name,
                })),
              ]}
              onChange={(event) => onChange(buildResultTarget(selectedAccount, event.target.value))}
            />
            {!savedConversationExists && currentConversationId && (
              <p className="mt-1 text-xs text-badge-warning" data-testid="cron-result-channel-conversation-unavailable">
                {cc.resultPushConversationUnavailable}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-xs text-zinc-500">{cc.resultPushNoConversations}</p>
        )
      )}

      {selectedAccount && conversationState && !conversationState.loading && (!conversationState.supported || conversationState.error) && (
        <div className="mt-2">
          <label className="mb-1 block text-xs text-zinc-400" htmlFor="cron-result-channel-manual">
            {cc.resultPushManualLabel}
          </label>
          <Input
            id="cron-result-channel-manual"
            value={currentConversationId}
            placeholder={cc.resultPushManualPlaceholder}
            onChange={(event) => onChange(buildResultTarget(selectedAccount, event.target.value))}
          />
          <p className="mt-1 text-xs text-zinc-500">
            {conversationState.error ? cc.resultPushListFailed : cc.resultPushManualHint}
          </p>
        </div>
      )}
    </div>
  );
};

export const CronResultChannelSummary: React.FC<{ value?: string }> = ({ value = '' }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const { accounts, accountsLoading, conversationsByAccount } = useChannelCatalog();
  const parsedTarget = useMemo(() => parseResultTarget(value), [value]);
  const account = parsedTarget ? findTargetAccount(accounts, parsedTarget.accountKey) : undefined;
  const conversationState = account ? conversationsByAccount[account.id] : undefined;
  const conversation = parsedTarget
    ? conversationState?.conversations.find((item) => item.id === parsedTarget.conversationId)
    : undefined;
  const accountUnavailable = Boolean(value && !accountsLoading && !account);
  const conversationUnavailable = Boolean(
    parsedTarget
    && account
    && conversationState?.supported
    && !conversationState.loading
    && !conversationState.error
    && !conversation,
  );
  const displayValue = !value
    ? cc.resultPushNone
    : account && parsedTarget
      ? `${account.name} → ${conversation?.name || parsedTarget.conversationId}`
      : value;

  return (
    <div className="min-w-0" data-testid="cron-result-channel-summary">
      <div className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="shrink-0 text-xs text-zinc-500">{cc.resultPushSummaryLabel}</span>
        <span className={`truncate ${accountUnavailable || conversationUnavailable ? 'text-badge-warning' : 'text-zinc-200'}`}>
          {displayValue}
        </span>
      </div>
      {accountUnavailable && (
        <p className="mt-1 max-w-xl text-xs text-badge-warning">
          {cc.resultPushAccountUnavailable.replace('{value}', value)}
        </p>
      )}
      {conversationUnavailable && (
        <p className="mt-1 max-w-xl text-xs text-badge-warning">{cc.resultPushConversationUnavailable}</p>
      )}
    </div>
  );
};
