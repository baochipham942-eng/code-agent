// ============================================================================
// CronMailEventFields —— 「新邮件」（connector:mail）触发的绑定选择
//（N-TRIGGER-MAIL-CREATE-ENTRY-K1）。
// 账号与邮箱都来自 useMailSources（cron:listMailSources → mail 连接器），全程下拉、
// 不给自由文本（账号名手滑打错 = 任务静默永不触发）。邮箱缺省 INBOX；换账号时
// 旧邮箱绑定不再有意义，回落默认。连接器不可用按 reason 给三态可区分提示
//（没启用 / 没授权 / 非 macOS），前两态带「去设置」按钮直达连接器设置。
// 预算字段与护栏提示与通道事件字段（CronEventScheduleFields）同款：event 任务
// 必填单次预算，判据来自 shared 校验器，呈现走 reason → 本地化文案。
// ============================================================================

import React from 'react';
import { CRON_EVENT_TRIGGER } from '@shared/constants';
import type { EventScheduleViolation } from '@shared/cronEventValidation';
import { Button } from '../../primitives/Button';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import { FormField } from '../../composites/FormField';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { useMailSources } from './useMailSources';

interface CronMailEventFieldsProps {
  /** 绑定的 Mail 账号名（mail connector 的账号名）；空 = 尚未选择。 */
  accountId: string;
  /** 监听邮箱名；空 = 缺省 INBOX（保存时不落键，host 归一到 INBOX）。 */
  mailbox: string;
  onAccountChange: (accountId: string) => void;
  onMailboxChange: (mailbox: string) => void;
  /** 单次预算上限（USD，draft 字符串）；event 任务必填 > 0。 */
  maxRunBudget: string;
  onBudgetChange: (value: string) => void;
  /** shared 校验器的违规（null = 合规）；mail 源的 invalid-schedule 映射成邮件专用文案。 */
  violation: EventScheduleViolation | null;
}

/** mail 源的 reason → 本地化文案：invalid-schedule 在 mail 语境是「还没选账号」，单独措辞。 */
export function mailEventValidationMessage(
  violation: EventScheduleViolation,
  cc: ReturnType<typeof useI18n>['t']['cronCenter'],
): string {
  return violation.reason === 'invalid-schedule'
    ? cc.eventMailInvalidAccount
    : cc.eventValidation[violation.reason];
}

export const CronMailEventFields: React.FC<CronMailEventFieldsProps> = ({
  accountId,
  mailbox,
  onAccountChange,
  onMailboxChange,
  maxRunBudget,
  onBudgetChange,
  violation,
}) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const { state, reload } = useMailSources();

  const validationMessage = violation ? mailEventValidationMessage(violation, cc) : null;
  const accounts = state.status === 'ready' ? state.accounts : [];
  const listedMailboxes = state.status === 'ready' ? (state.mailboxesByAccount[accountId] ?? []) : [];
  const staleAccount = state.status === 'ready' && accountId !== '' && !accounts.some((account) => account.name === accountId);

  const handleAccountChange = (value: string) => {
    if (value === '__unavailable__') return;
    onAccountChange(value);
    // 邮箱隶属于账号：换账号时旧邮箱不再有意义，回落缺省 INBOX。
    onMailboxChange('');
  };

  const accountOptions = [
    ...(staleAccount ? [{ value: '__unavailable__', label: accountId }] : []),
    { value: '', label: cc.eventMailAccountPlaceholder, disabled: true },
    ...accounts.map((account) => ({ value: account.name, label: account.name })),
  ];

  const mailboxOptions = [
    // 空 value = 缺省 INBOX（不落键）；排在首位，显式选其他邮箱后仍可切回。
    { value: '', label: cc.eventMailboxDefaultLabel },
    ...listedMailboxes
      .filter((name) => name !== CRON_EVENT_TRIGGER.DEFAULT_MAILBOX)
      .map((name) => ({ value: name, label: name })),
  ];

  return (
    <div className="space-y-3" data-testid="cron-mail-event-fields">
      <FormField label={cc.eventMailAccountLabel} required htmlFor="cron-event-mail-account">
        <Select
          id="cron-event-mail-account"
          value={staleAccount ? '__unavailable__' : accountId}
          options={accountOptions}
          onChange={(event) => handleAccountChange(event.target.value)}
          disabled={state.status !== 'ready'}
        />
      </FormField>

      {state.status === 'loading' && <p className="text-xs text-zinc-500">{cc.resultPushLoading}</p>}

      {state.status === 'empty' && (
        <p className="text-xs text-zinc-500" data-testid="cron-event-mail-no-accounts">
          {cc.eventMailNoAccounts}
        </p>
      )}

      {state.status === 'unavailable' && (
        <div
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-badge-warning"
          data-testid="cron-event-mail-unavailable"
        >
          <p>
            {state.reason === 'connector-not-enabled' && cc.eventMailUnavailableNotEnabled}
            {state.reason === 'not-authorized' && cc.eventMailUnavailableNotAuthorized}
            {state.reason === 'unsupported-platform' && cc.eventMailUnavailablePlatform}
            {state.reason === 'read-error' && cc.eventMailReadError}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {(state.reason === 'connector-not-enabled' || state.reason === 'not-authorized') && (
              <Button size="sm" variant="ghost" onClick={() => openSettingsTab('mcp')}>
                {cc.eventMailGoSettings}
              </Button>
            )}
            {state.reason === 'read-error' && (
              <Button size="sm" variant="ghost" onClick={reload}>
                {cc.eventMailRetry}
              </Button>
            )}
          </div>
        </div>
      )}

      {staleAccount && (
        <div
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-badge-warning"
          data-testid="cron-event-mail-account-unavailable"
        >
          {cc.eventMailAccountUnavailable.replace('{value}', accountId)}
        </div>
      )}

      <FormField label={cc.eventMailboxLabel} htmlFor="cron-event-mailbox">
        <Select
          id="cron-event-mailbox"
          value={mailbox}
          options={mailboxOptions}
          onChange={(event) => onMailboxChange(event.target.value)}
          disabled={state.status !== 'ready' || accountId === ''}
        />
      </FormField>
      <p className="text-xs text-zinc-500" data-testid="cron-event-mail-seed-hint">
        {cc.eventMailSeedHint}
      </p>

      <FormField
        label={cc.eventBudgetLabel}
        required
        htmlFor="cron-event-mail-budget"
        hint={cc.eventBudgetHint}
      >
        <Input
          id="cron-event-mail-budget"
          type="number"
          value={maxRunBudget}
          onChange={(event) => onBudgetChange(event.target.value)}
          placeholder="0.5"
        />
      </FormField>

      <p className="text-xs text-zinc-500">{cc.eventConstraintsHint}</p>

      {validationMessage && (
        <div
          className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-badge-danger"
          data-testid="cron-event-mail-validation"
        >
          {validationMessage}
        </div>
      )}
    </div>
  );
};
