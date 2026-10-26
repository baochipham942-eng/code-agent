// ============================================================================
// CronEventScheduleFields —— 'event' 调度（通道消息/群监听）的触发源选择。
// 账号 + 可选会话/群都来自 useChannelCatalog（与结果推送同一份目录）；选了具体
// 群 = 群监听绑定（未 @ 也触发），留空 = 该账号任意会话。
// connector:mail 源的草稿不走本组件：mail 源有自己的编辑 UI（CronMailEventFields，
// N-TRIGGER-MAIL-CREATE-ENTRY-K1 起），draft 级 scheduleType 分型为 'event-mail'。
// 单次预算上限是 event 任务的必填项，直接摆在触发源旁边（不藏进「高级选项」），
// 与高级选项里的同一个 draft 字段双向同步。护栏提示按 shared 校验器的 reason
// 映射出的本地化文案渲染（校验判据与 createJob 同一份；是否显示由外层闸门控制，
// 选完调度类型不立刻报）。
// ============================================================================

import React, { useEffect, useRef } from 'react';
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
  /** 选定账号；第二参带回通道目录里的账号显示名（确认卡行摘要用，编辑器等调用方可忽略）。 */
  onAccountChange: (accountId: string, accountName?: string) => void;
  /** 选定会话/群（空 = 任意会话）；第二参带回目录里的群显示名（同上，可忽略）。 */
  onChatChange: (chatId: string, chatName?: string) => void;
  /** 单次预算上限（USD，draft 字符串）；event 任务必填 > 0。 */
  maxRunBudget: string;
  onBudgetChange: (value: string) => void;
  /** 按校验器 reason 映射出的本地化违规文案；null = 合规或未到显示时机。 */
  validationMessage: string | null;
  /**
   * 按群名预选（/schedule event 草案的用户原话群名）：选中账号的会话目录加载完、
   * 且用户还没手选群（chatId 空）时，目录里有同名群就自动选上。编辑器不传 = 行为不变。
   */
  preferredChatName?: string;
}

export const CronEventScheduleFields: React.FC<CronEventScheduleFieldsProps> = ({
  accountId,
  chatId,
  onAccountChange,
  onChatChange,
  maxRunBudget,
  onBudgetChange,
  validationMessage,
  preferredChatName,
}) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const { accounts, accountsLoading, conversationsByAccount } = useChannelCatalog();

  // 按群名预选：回调走 ref，避免调用方内联箭头让本效应随每次渲染重跑。
  const onChatChangeRef = useRef(onChatChange);
  onChatChangeRef.current = onChatChange;
  // 预选每个群名只尝试一次（rework r1 Important 2）：目录就绪后为本 preferredChatName
  // 做过一次判定（选中同名群或确认没有）就记下——用户随后把群改回「任意会话」、或
  // 换账号清空选择时，不能因为 chatId 又空了就把显式选择弹回同名群。
  const preselectedChatNamesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!preferredChatName || chatId) return;
    if (preselectedChatNamesRef.current.has(preferredChatName)) return;
    const state = conversationsByAccount[accountId];
    if (!state || state.loading) return;
    preselectedChatNamesRef.current.add(preferredChatName);
    const match = state.conversations.find(
      (conversation) => conversation.name.trim() === preferredChatName.trim(),
    );
    if (match) onChatChangeRef.current(match.id, match.name);
  }, [preferredChatName, chatId, accountId, conversationsByAccount]);

  const selectedAccount = accounts.find((account) => account.id === accountId);
  const staleAccount = Boolean(accountId && !accountsLoading && !selectedAccount);
  const conversationState = selectedAccount ? conversationsByAccount[selectedAccount.id] : undefined;

  const handleAccountChange = (value: string) => {
    if (value === '__unavailable__') return;
    onAccountChange(value, accounts.find((account) => account.id === value)?.name);
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
              onChange={(event) => onChatChange(
                event.target.value,
                conversationState.conversations.find((conversation) => conversation.id === event.target.value)?.name,
              )}
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
