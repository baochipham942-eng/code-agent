// ============================================================================
// Date Grouping - 会话按日期分组工具
// ============================================================================

export type DateGroup = 'pinned' | 'today' | 'yesterday' | 'thisWeek' | 'earlier';

export const DATE_GROUP_LABELS: Record<DateGroup, string> = {
  pinned: '已置顶',
  today: '今天',
  yesterday: '昨天',
  thisWeek: '本周',
  earlier: '更早',
};

/**
 * 根据时间戳判断所属日期分组
 */
export function getDateGroup(timestamp: number): Exclude<DateGroup, 'pinned'> {
  const now = new Date();
  const date = new Date(timestamp);

  // 今天的起始时间
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // 昨天的起始时间
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  // 本周一的起始时间（周一为一周开始）
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = todayStart - mondayOffset * 24 * 60 * 60 * 1000;

  const ts = date.getTime();

  if (ts >= todayStart) return 'today';
  if (ts >= yesterdayStart) return 'yesterday';
  if (ts >= weekStart) return 'thisWeek';
  return 'earlier';
}

/**
 * 将会话列表按日期分组，置顶项单独一组
 * 每组内按 updatedAt 降序排列
 */
export function groupSessions<T extends { id: string; updatedAt: number }>(
  sessions: T[],
  pinnedIds: Set<string>
): Array<{ group: DateGroup; label: string; sessions: T[] }> {
  const groups: Record<DateGroup, T[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };

  for (const session of sessions) {
    if (pinnedIds.has(session.id)) {
      groups.pinned.push(session);
    } else {
      const group = getDateGroup(session.updatedAt);
      groups[group].push(session);
    }
  }

  // 每组内按 updatedAt 降序
  const groupOrder: DateGroup[] = ['pinned', 'today', 'yesterday', 'thisWeek', 'earlier'];
  const result: Array<{ group: DateGroup; label: string; sessions: T[] }> = [];

  for (const group of groupOrder) {
    const items = groups[group];
    if (items.length > 0) {
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      result.push({
        group,
        label: DATE_GROUP_LABELS[group],
        sessions: items,
      });
    }
  }

  return result;
}
