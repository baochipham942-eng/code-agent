// ============================================================================
// SavedRoutineRestate —— 保存成功后的只读复述视图（N-ROLE-ROUTINE-RESTATE）。
// 三行（做什么 / 什么时候 / 结果送到哪里）全部取自保存成功的定义，与表单状态
// 无关；Done 走原来的关闭回调。角色名（listRoles 花名）与通道目录在这里异步
// 解析，解析前先回落 roleId / 账号名，行内容始终非空。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { CronJobDefinition } from '@shared/contract';
import { cronJobBoundRoleId } from '@shared/cronRoleBinding';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { listRoles } from '../../../services/rolesClient';
import { useChannelCatalog } from './useChannelCatalog';
import {
  buildSavedRoutineRestateRows,
  resolveSavedRoutineChannelLabel,
} from './savedRoutineRows';

interface SavedRoutineRestateProps {
  /** 保存成功（create/update 返回）的角色绑定任务定义。 */
  job: CronJobDefinition;
  /** 关闭视图：与保存前的完成/取消同一回调。 */
  onDone: () => void;
}

export const SavedRoutineRestate: React.FC<SavedRoutineRestateProps> = ({ job, onDone }) => {
  const { t, language } = useI18n();
  const sc = t.scheduleConfirm;
  const cc = t.cronCenter;
  const roleId = cronJobBoundRoleId(job);
  // 角色显示名：listRoles 命中用花名；没等到（或角色已删）回落 roleId，与创建入口的
  // 选择器回落同口径，行内容不闪空。
  const [roleDisplayName, setRoleDisplayName] = useState(roleId);
  useEffect(() => {
    let active = true;
    if (!roleId) return;
    listRoles()
      .then((roles) => {
        if (active) {
          setRoleDisplayName(roles.find((role) => role.roleId === roleId)?.displayName || roleId);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [roleId]);

  const { accounts, conversationsByAccount } = useChannelCatalog();
  const channelLabel = useMemo(
    () => resolveSavedRoutineChannelLabel(job.resultChannel || '', { accounts, conversationsByAccount }),
    [job.resultChannel, accounts, conversationsByAccount],
  );

  const rows = useMemo(() => buildSavedRoutineRestateRows({
    job,
    roleDisplayName,
    channelLabel,
    labels: {
      what: sc.what,
      when: sc.when,
      result: sc.result,
      fallbackWhat: sc.fallbackWhat,
      reviewInbox: sc.reviewInbox,
      savedWhenEvent: cc.savedRestateWhenEvent,
      savedRolePrefix: cc.savedRestateRolePrefix,
      savedStatusLabel: cc.savedRestateStatusLabel,
      savedStatusPaused: cc.savedRestateStatusPaused,
    },
    lang: language,
  }), [job, roleDisplayName, channelLabel, sc, cc, language]);

  return (
    <div data-testid="cron-saved-routine-restate" className="space-y-3">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-badge-success" aria-hidden="true" />
        <span className="text-sm font-medium text-zinc-100">{cc.savedRestateTitle}</span>
      </div>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div
            key={row.key}
            className="grid grid-cols-[auto_1fr] gap-3 rounded-md bg-emerald-500/5 px-2.5 py-1.5"
            data-saved-routine-row={row.key}
          >
            <span className="text-[10px] text-zinc-500">{row.label}</span>
            <span
              className="min-w-0 text-[11px] leading-relaxed break-words text-zinc-200"
              data-saved-routine-value={row.key}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end pt-1">
        <Button onClick={onDone} data-testid="cron-saved-routine-done">
          {cc.savedRestateDone}
        </Button>
      </div>
    </div>
  );
};
