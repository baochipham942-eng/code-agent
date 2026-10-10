// ============================================================================
// dateGrouping.test.ts - 会话按日期分组测试
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDateGroup, groupSessions, DATE_GROUP_LABELS } from '../../../src/renderer/utils/dateGrouping';

// 本地日历分量构造时间戳：getDateGroup 按机器本地日历分组，
// 夹具也必须按本地分量构造，否则同一瞬间在不同 TZ 下会落到不同的本地日。
const local = (y: number, mo: number, d: number, h = 12, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi, 0).getTime();

// ============================================================================
// getDateGroup
// ============================================================================

describe('getDateGroup', () => {
  beforeEach(() => {
    // Fix time to 2026-03-16 Monday 14:00:00 local time
    vi.useFakeTimers();
    vi.setSystemTime(new Date(local(2026, 3, 16, 14)));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return "today" for current timestamp', () => {
    expect(getDateGroup(Date.now())).toBe('today');
  });

  it('should return "today" for earlier today', () => {
    const today = new Date(local(2026, 3, 16, 2));
    expect(getDateGroup(today.getTime())).toBe('today');
  });

  it('should return "yesterday" for yesterday', () => {
    const yesterday = new Date(local(2026, 3, 15, 12));
    expect(getDateGroup(yesterday.getTime())).toBe('yesterday');
  });

  it('should return "thisWeek" for earlier this week (after Monday)', () => {
    // 2026-03-16 is Monday, so "this week" starts on Monday 03-16.
    // 03-15 (Sunday) is actually last week for Monday-start weeks,
    // but let's check a day that would be thisWeek if we were on Wednesday.
    // Let's move time to Wednesday 2026-03-18
    vi.setSystemTime(new Date(local(2026, 3, 18, 14)));
    // Monday of that week = 2026-03-16
    const monday = new Date(local(2026, 3, 16, 12));
    expect(getDateGroup(monday.getTime())).toBe('thisWeek');
  });

  it('should return "earlier" for dates before this week', () => {
    const oldDate = new Date(local(2026, 3, 1, 12));
    expect(getDateGroup(oldDate.getTime())).toBe('earlier');
  });

  it('should return "earlier" for invalid timestamp (0)', () => {
    expect(getDateGroup(0)).toBe('earlier');
  });

  it('should return "earlier" for NaN', () => {
    expect(getDateGroup(NaN)).toBe('earlier');
  });

  it('should return "earlier" for Infinity', () => {
    expect(getDateGroup(Infinity)).toBe('earlier');
  });
});

// ============================================================================
// groupSessions
// ============================================================================

describe('groupSessions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(local(2026, 3, 16, 14)));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const now = local(2026, 3, 16, 14);
  const yesterdayTs = local(2026, 3, 15, 10);
  const oldTs = local(2026, 2, 1, 10);

  it('should separate pinned sessions into their own group', () => {
    const sessions = [
      { id: 's1', updatedAt: now },
      { id: 's2', updatedAt: now - 1000 },
    ];
    const pinnedIds = new Set(['s1']);

    const result = groupSessions(sessions, pinnedIds);
    const pinnedGroup = result.find((g) => g.group === 'pinned');
    expect(pinnedGroup).toBeDefined();
    expect(pinnedGroup!.sessions).toHaveLength(1);
    expect(pinnedGroup!.sessions[0].id).toBe('s1');
  });

  it('should group sessions by date', () => {
    const sessions = [
      { id: 's1', updatedAt: now },
      { id: 's2', updatedAt: yesterdayTs },
      { id: 's3', updatedAt: oldTs },
    ];

    const result = groupSessions(sessions, new Set());
    expect(result.some((g) => g.group === 'today')).toBe(true);
    expect(result.some((g) => g.group === 'yesterday')).toBe(true);
    expect(result.some((g) => g.group === 'earlier')).toBe(true);
  });

  it('should sort sessions within each group by updatedAt descending', () => {
    const sessions = [
      { id: 's1', updatedAt: now - 5000 },
      { id: 's2', updatedAt: now - 1000 },
      { id: 's3', updatedAt: now - 3000 },
    ];

    const result = groupSessions(sessions, new Set());
    const todayGroup = result.find((g) => g.group === 'today');
    expect(todayGroup).toBeDefined();
    expect(todayGroup!.sessions.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
  });

  it('should not include empty groups', () => {
    const sessions = [{ id: 's1', updatedAt: now }];
    const result = groupSessions(sessions, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].group).toBe('today');
  });

  it('should handle empty session list', () => {
    const result = groupSessions([], new Set());
    expect(result).toEqual([]);
  });

  it('should use correct labels', () => {
    expect(DATE_GROUP_LABELS.pinned).toBe('已置顶');
    expect(DATE_GROUP_LABELS.today).toBe('今天');
    expect(DATE_GROUP_LABELS.yesterday).toBe('昨天');
    expect(DATE_GROUP_LABELS.thisWeek).toBe('本周');
    expect(DATE_GROUP_LABELS.earlier).toBe('更早');
  });

  it('should maintain group order: pinned > today > yesterday > thisWeek > earlier', () => {
    // Move to Wednesday so we can have a "thisWeek" that's not today/yesterday
    vi.setSystemTime(new Date(local(2026, 3, 18, 14)));
    const wednesdayNow = local(2026, 3, 18, 14);
    const mondayTs = local(2026, 3, 16, 10);
    const tuesdayTs = local(2026, 3, 17, 10);

    const sessions = [
      { id: 'old', updatedAt: oldTs },
      { id: 'pinned1', updatedAt: wednesdayNow },
      { id: 'today1', updatedAt: wednesdayNow - 1000 },
      { id: 'yesterday1', updatedAt: tuesdayTs },
      { id: 'week1', updatedAt: mondayTs },
    ];

    const result = groupSessions(sessions, new Set(['pinned1']));
    const groupOrder = result.map((g) => g.group);
    expect(groupOrder).toEqual(['pinned', 'today', 'yesterday', 'thisWeek', 'earlier']);
  });
});
