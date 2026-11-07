// ============================================================================
// PendingRoutineRestate —— 保存前确认卡（N-CRON-MORNING-TRIAGE-REST1）。
// 无角色任务（简易创建 / 手动表单 / 模板填参，create 与 edit）在 createJob/
// updateJob 之前先出四行复述（做什么 / 什么时候 / 什么变化值得通知 / 结果送到
// 哪里），「确认保存」才真正落库，「返回修改」原样回到表单（表单状态不丢）。
// 行文案与聊天侧 /schedule 确认卡、保存后复述视图同一份 builder
// （savedRoutineRows.buildSavedRoutineRestateRows ← buildScheduleConfirmRows），
// 不另立一套措辞。角色绑定任务不走这张卡（保存后照旧出 SavedRoutineRestate）。
// ============================================================================

import React, { useMemo } from 'react';
import { Clock3 } from 'lucide-react';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { useChannelCatalog } from './useChannelCatalog';
import {
  buildSavedRoutineRestateRows,
  resolveSavedRoutineChannelLabel,
  type SavedRoutineJobSource,
} from './savedRoutineRows';
import type { PendingRoutineMode } from './usePendingRoutineGate';

interface PendingRoutineRestateProps {
  /** buildCronJobInput 产出的待保存输入（尚未落库，编辑器/简易创建的表单值编译结果）。 */
  input: SavedRoutineJobSource;
  /** 新建 vs 编辑已有任务：副标题区分「还没有创建任何任务」与「改动还没有保存」。 */
  mode?: PendingRoutineMode;
  /** 确认保存进行中（createJob/updateJob await 期间）：确认按钮 loading、返回禁用。 */
  confirming: boolean;
  /** create/update 抛错的用户可读文案：卡顶横幅呈现；返回修改后仍在表单错误框里。 */
  error?: string | null;
  onConfirm: () => void;
  onBack: () => void;
}

export const PendingRoutineRestate: React.FC<PendingRoutineRestateProps> = ({
  input,
  mode = 'create',
  confirming,
  error,
  onConfirm,
  onBack,
}) => {
  const { t, language } = useI18n();
  const sc = t.scheduleConfirm;
  const cc = t.cronCenter;
  const { accounts, conversationsByAccount } = useChannelCatalog();
  const channelLabel = useMemo(
    () => resolveSavedRoutineChannelLabel(input.resultChannel || '', { accounts, conversationsByAccount }),
    [input.resultChannel, accounts, conversationsByAccount],
  );

  const rows = useMemo(() => buildSavedRoutineRestateRows({
    job: input,
    channelLabel,
    labels: {
      what: sc.what,
      when: sc.when,
      notifyWhen: sc.notifyWhen,
      fallbackNotifyWhen: sc.fallbackNotifyWhen,
      result: sc.result,
      fallbackWhat: sc.fallbackWhat,
      reviewInbox: sc.reviewInbox,
      savedWhenEvent: cc.savedRestateWhenEvent,
      savedRolePrefix: cc.savedRestateRolePrefix,
      savedStatusLabel: cc.savedRestateStatusLabel,
      savedStatusPaused: cc.savedRestateStatusPaused,
    },
    lang: language,
    notifyWhenRow: true,
  }), [input, channelLabel, sc, cc, language]);

  return (
    <div data-testid="cron-pending-routine-restate" className="space-y-3">
      <div className="flex items-center gap-2">
        <Clock3 className="h-4 w-4 text-badge-accent" aria-hidden="true" />
        <span className="text-sm font-medium text-zinc-100">{cc.pendingRestateTitle}</span>
      </div>
      <p className="text-xs leading-relaxed text-zinc-500">
        {mode === 'update' ? cc.pendingRestateHintUpdate : cc.pendingRestateHint}
      </p>
      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-badge-danger">
          {error}
        </div>
      )}
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div
            key={row.key}
            className="grid grid-cols-[auto_1fr] gap-3 rounded-md bg-indigo-500/5 px-2.5 py-1.5"
            data-pending-routine-row={row.key}
          >
            <span className="text-[10px] text-zinc-500">{row.label}</span>
            <span
              className="min-w-0 text-[11px] leading-relaxed break-words text-zinc-200"
              data-pending-routine-value={row.key}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onBack} disabled={confirming} data-testid="cron-pending-routine-back">
          {cc.pendingRestateBack}
        </Button>
        <Button onClick={onConfirm} loading={confirming} data-testid="cron-pending-routine-confirm">
          {cc.pendingRestateConfirm}
        </Button>
      </div>
    </div>
  );
};
