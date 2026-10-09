// ============================================================================
// CronEventScheduleFields —— 'event' 调度（通道消息/群监听）的触发源选择。
// 账号 + 可选会话/群都来自 useChannelCatalog（与结果推送同一份目录）；选了具体
// 群 = 群监听绑定（未 @ 也触发），留空 = 该账号任意会话。
// 单次预算上限是 event 任务的必填项，直接摆在触发源旁边（不藏进「高级选项」），
// 与高级选项里的同一个 draft 字段双向同步。护栏提示按 shared 校验器的 reason
// 映射出的本地化文案渲染（校验判据与 createJob 同一份；是否显示由外层闸门控制，
// 选完调度类型不立刻报）。
// ============================================================================

import React from 'react';
import { Button } from '../../primitives/Button';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import { FormField } from '../../composites/FormField';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { useChannelCatalog } from './useChannelCatalog';

interface CronEventScheduleFieldsProps {
  /** 绑定的通道账号 id；空 = 尚未选择（未通过护栏）。 */
  accountId: string;
  /** 限定的会话/群 id；空 = 该账号任意会话。 */
  chatId: string;
  onAccountChange: (accountId: string) => void;
  onChatChange: (chatId: string) => void;
  /** 单次预算上限（USD，draft 字符串）；event 任务必填 > 0。 */
  maxRunBudget: string;
  onBudgetChange: (value: string) => void;
  /** 按校验器 reason 映射出的本地化违规文案；null = 合规或未到显示时机。 */
  validationMessage: string | null;
}

export const CronEventScheduleFields: React.FC<CronEventScheduleFieldsProps> = ({
  accountId,
  chatId,
  onAccountChange,
  onChatChange,
  maxRunBudget,
  onBudgetChange,
  validationMessage,
}) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const { accounts, accountsLoading, conversationsByAccount } = useChannelCatalog();

  const selectedAccount = accounts.find((account) => account.id === accountId);
  const staleAccount = Boolean(accountId && !accountsLoading && !selectedAccount);
  const conversationState = selectedAccount ? conversationsByAccount[selectedAccount.id] : undefined;

  const handleAccountChange = (value: string) => {
    if (value === '__unavailable__') return;
    onAccountChange(value);
    // 会话/群隶属于账号：换账号时旧绑定不再有意义，清掉回到「任意会话」。
    onChatChange('');
  };

  const accountOptions = [
    ...(staleAccount ? [{ value: '__unavailable__', label: accountId }] : []),
    { value: '', label: cc.eventAccountPlaceholder, disabled: true },
    ...accounts.map((account) => ({
      value: account.id,
      // 账号名是用户自己起的，不拼内部通道类型串（同 CronResultChannel 的口径）。
      label: account.name,
    })),
  ];

  const chatListed = conversationState?.conversations.some((conversation) => conversation.id === chatId) ?? false;
  const chatOptions = [
    { value: '', label: cc.eventChatAny },
    ...(!chatListed && chatId ? [{ value: chatId, label: chatId }] : []),
    ...(conversationState?.conversations.map((conversation) => ({
      value: conversation.id,
      label: conversation.name,
    })) ?? []),
  ];

  return (
    <div className="space-y-3" data-testid="cron-event-schedule-fields">
      <FormField label={cc.eventAccountLabel} required htmlFor="cron-event-account">
        <Select
          id="cron-event-account"
          value={staleAccount ? '__unavailable__' : accountId}
          options={accountOptions}
          onChange={(event) => handleAccountChange(event.target.value)}
          disabled={accountsLoading}
        />
      </FormField>

      {accountsLoading && <p className="text-xs text-zinc-500">{cc.resultPushLoading}</p>}

      {!accountsLoading && accounts.length === 0 && !staleAccount && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>{cc.eventNoAccounts}</span>
          <Button size="sm" variant="ghost" onClick={() => openSettingsTab('channels')}>
            {cc.resultPushConnect}
          </Button>
        </div>
      )}

      {staleAccount && (
        <div
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-badge-warning"
          data-testid="cron-event-account-unavailable"
        >
          {cc.eventAccountUnavailable.replace('{value}', accountId)}
        </div>
      )}

      {selectedAccount && conversationState?.loading && (
        <p className="text-xs text-zinc-500">{cc.resultPushLoading}</p>
      )}

      {selectedAccount && conversationState && !conversationState.loading && conversationState.supported && !conversationState.error && (
        <div>
          <FormField label={cc.eventChatLabel} htmlFor="cron-event-chat">
            <Select
              id="cron-event-chat"
              value={chatId}
              options={chatOptions}
              onChange={(event) => onChatChange(event.target.value)}
            />
          </FormField>
          <p className="mt-1 text-xs text-zinc-500">{cc.eventChatHint}</p>
        </div>
      )}

      {selectedAccount && conversationState && !conversationState.loading && (!conversationState.supported || conversationState.error) && (
        <div>
          <FormField label={cc.eventChatManualLabel} htmlFor="cron-event-chat-manual">
            <Input
              id="cron-event-chat-manual"
              value={chatId}
              placeholder={cc.eventChatManualPlaceholder}
              onChange={(event) => onChatChange(event.target.value)}
            />
          </FormField>
          <p className="mt-1 text-xs text-zinc-500">
            {conversationState.error ? cc.resultPushListFailed : cc.eventChatManualHint}
          </p>
        </div>
      )}

      <FormField
        label={cc.eventBudgetLabel}
        required
        htmlFor="cron-event-budget"
        hint={cc.eventBudgetHint}
      >
        <Input
          id="cron-event-budget"
          type="number"
          value={maxRunBudget}
          onChange={(event) => onBudgetChange(event.target.value)}
          placeholder="0.5"
        />
      </FormField>

      <p className="text-xs text-zinc-500" data-testid="cron-event-constraints-hint">
        {cc.eventConstraintsHint}
      </p>

      {validationMessage && (
        <div
          className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-badge-danger"
          data-testid="cron-event-validation"
        >
          {validationMessage}
        </div>
      )}
    </div>
  );
};
