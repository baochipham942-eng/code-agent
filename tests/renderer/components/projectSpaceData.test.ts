import { describe, expect, it } from 'vitest';
import {
  buildProjectActivityFeed,
  deriveProjectActivityStatus,
  PROJECT_ACTIVE_WINDOW_MS,
  PROJECT_ACTIVITY_FEED_LIMIT,
} from '../../../src/renderer/components/features/projectSpace/projectSpaceData';

describe('buildProjectActivityFeed（批P 动态流三源合并）', () => {
  it('三源按时间倒序合并，topic 带状态、artifact 带来源会话', () => {
    const feed = buildProjectActivityFeed({
      sessions: [{ id: 's1', title: '落地页会话', updatedAt: 300 }],
      cards: [{ id: 'nwc_1', title: '整理竞品', status: 'working', updatedAt: 500, sourceConversationId: 's1' }],
      artifacts: [{ id: 'art_1', title: '竞品报告.md', sessionId: 's1', createdAt: 400 }],
    });
    expect(feed.map((entry) => entry.kind)).toEqual(['topic', 'artifact', 'session']);
    expect(feed[0].topicStatus).toBe('working');
    expect(feed[1].sessionId).toBe('s1');
  });

  it('无效时间戳丢弃，标题缺失给兜底文案', () => {
    const feed = buildProjectActivityFeed({
      sessions: [
        { id: 's0', title: '坏数据', updatedAt: 0 },
        { id: 's1', title: '  ', updatedAt: 100 },
      ],
      cards: [],
      artifacts: [{ id: 'art_1', title: undefined, sessionId: 's1', createdAt: 90 }],
    });
    expect(feed).toHaveLength(2);
    expect(feed[0].title).toBe('未命名会话');
    expect(feed[1].title).toBe('未命名产物');
  });

  it('状态 chip 按活跃度派生：DB status=active 但无活跃 topic 且超 7 天 → 空闲（消除满屏活跃+矛盾）', () => {
    const NOW = 1_800_000_000_000;
    expect(deriveProjectActivityStatus({ status: 'active', activeTopicCount: 0, lastActivityAt: NOW - PROJECT_ACTIVE_WINDOW_MS - 1 }, NOW)).toBe('idle');
    expect(deriveProjectActivityStatus({ status: 'active', activeTopicCount: 0, lastActivityAt: null }, NOW)).toBe('idle');
    // 有活跃 topic 就是活跃（即使 DB status=idle——「空闲但 7 个活跃 topic」矛盾的正解）
    expect(deriveProjectActivityStatus({ status: 'idle', activeTopicCount: 7, lastActivityAt: null }, NOW)).toBe('active');
    expect(deriveProjectActivityStatus({ status: 'active', activeTopicCount: 0, lastActivityAt: NOW - 60_000 }, NOW)).toBe('active');
    expect(deriveProjectActivityStatus({ status: 'archived', activeTopicCount: 7, lastActivityAt: NOW }, NOW)).toBe('archived');
  });

  it('超量截断到 limit（默认 50）', () => {
    const sessions = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, title: `会话${i}`, updatedAt: i + 1 }));
    const feed = buildProjectActivityFeed({ sessions, cards: [], artifacts: [] });
    expect(feed).toHaveLength(PROJECT_ACTIVITY_FEED_LIMIT);
    expect(feed[0].at).toBe(60);
  });
});
