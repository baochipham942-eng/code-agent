// ============================================================================
// usePendingRoutineGate —— 无角色任务的「先复述、确认后再保存」门
// （N-CRON-MORNING-TRIAGE-REST1）。CronJobEditor（手动表单 create/edit + 模板
// 填参）与 CronSimpleCreate 共用：提交时构建好的 create 输入先过
// isRoleBoundCronJob——角色绑定照旧立即落库（保存后出 SavedRoutineRestate），
// 无角色挂起等确认卡点「确认保存」；「返回修改」丢弃挂起输入、表单状态原样。
// ============================================================================

import { useCallback, useState } from 'react';
import { isRoleBoundCronJob } from '@shared/cronRoleBinding';
import type { SavedRoutineJobSource } from './savedRoutineRows';

export type PendingRoutineMode = 'create' | 'update';

export interface PendingRoutineSave {
  input: SavedRoutineJobSource;
  mode: PendingRoutineMode;
}

/**
 * @param persist 真正执行 createJob/updateJob 的回调（调用方持有各自的完成分支：
 * 保存后复述 / webhook 一次性链接 / 关闭弹窗 / 错误进表单错误框）。返回 true =
 * 已落库并交接完成（门随之清空挂起输入）；false = 出错（挂起输入保留，卡在场，
 * 用户可重试确认或返回修改）。
 */
export function usePendingRoutineGate(persist: (pending: PendingRoutineSave) => Promise<boolean>): {
  /** 挂起待确认的输入；非 null 时调用方渲染 PendingRoutineRestate。 */
  pending: PendingRoutineSave | null;
  /** 提交入口：角色绑定直存，无角色挂起等确认。 */
  gateOrPersist: (input: SavedRoutineJobSource, mode?: PendingRoutineMode) => Promise<void>;
  /** 确认卡「确认保存」：对挂起输入执行 persist；成功才清空。 */
  confirm: () => Promise<void>;
  /** 确认卡「返回修改」：丢弃挂起输入（表单状态不动）。 */
  back: () => void;
  /** 弹窗重开（关→开）时清残留的挂起输入。 */
  reset: () => void;
} {
  const [pending, setPending] = useState<PendingRoutineSave | null>(null);

  const gateOrPersist = useCallback(async (input: SavedRoutineJobSource, mode: PendingRoutineMode = 'create') => {
    if (!isRoleBoundCronJob(input)) {
      setPending({ input, mode });
      return;
    }
    const saved = await persist({ input, mode });
    if (saved) setPending(null);
  }, [persist]);

  const confirm = useCallback(async () => {
    if (pending == null) return;
    const saved = await persist(pending);
    if (saved) setPending(null);
  }, [pending, persist]);

  const back = useCallback(() => setPending(null), []);
  const reset = useCallback(() => setPending(null), []);

  return { pending, gateOrPersist, confirm, back, reset };
}
