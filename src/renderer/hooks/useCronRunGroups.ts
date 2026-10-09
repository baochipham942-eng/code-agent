import { useMemo } from 'react';
import type { CronRunGroupable, CronRunGroups } from '@shared/cronRunDigest';
import { useSessionStore, type SessionWithMeta } from '../stores/sessionStore';

/** 按任务聚合后的最小形状：侧栏折叠运行会话只需要这两个数。 */
export interface CronTaskRunAggregate {
  runCount: number;
  latestSessionId: string;
}

/** 分组结果 → origin.id（cron/heartbeat 任务 id）到 { runCount, latestSessionId } 的映射。 */
export function cronRunAggregatesByTaskId<T extends CronRunGroupable>(
  groups: CronRunGroups<T>,
): Record<string, CronTaskRunAggregate> {
  return Object.fromEntries(
    Object.values(groups.groups).map((group) => [
      group.taskId,
      { runCount: group.runCount, latestSessionId: group.latestSessionId },
    ]),
  );
}

/**
 * 侧栏会话列表的分组运行数据（store 的 getCronRunGroups 选择器在组件侧的稳定入口）：
 * 按 sessions 记忆化，sessions 不变不重算。会话行按任务折叠的渲染在侧栏 redesign 里做，
 * 这里先把数据层备好。
 */
export function useCronRunGroups(): CronRunGroups<SessionWithMeta> {
  const sessions = useSessionStore((state) => state.sessions);
  const getCronRunGroups = useSessionStore((state) => state.getCronRunGroups);
  return useMemo(() => getCronRunGroups(), [getCronRunGroups, sessions]);
}
