// ============================================================================
// DesktopPresence 单测（N-NOTIFY-PRESENCE-HEARTBEAT ①）——假时钟钉四态
// ============================================================================
// 单例 + 显式 now 注入（方法级 now 覆盖实例时钟），每个用例先 report 自己的状态，
// session id 互不重叠，跨用例无串扰。真值只依赖最近一条 report 与 viewedAt 表。
import { describe, expect, it, vi } from 'vitest';
import { desktopPresence } from '../../../src/host/services/companion/desktopPresence';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';

const T0 = 1_000_000;

describe('DesktopPresence.isActive', () => {
  it('新鲜报告：可见 + 聚焦 + 窗内最近输入 → 在场', () => {
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0 - 1_000 }, T0);
    expect(desktopPresence.isActive(T0)).toBe(true);
  });

  it('窗边界：报告与最近输入恰好都在窗内仍算在场，任一超出 1ms 即过期', () => {
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0 }, T0);
    expect(desktopPresence.isActive(T0 + L.desktopPresenceFreshMs)).toBe(true);
    expect(desktopPresence.isActive(T0 + L.desktopPresenceFreshMs + 1)).toBe(false);
  });

  it('报告本身超出新鲜窗 → 不在场', () => {
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0 + L.desktopPresenceFreshMs }, T0);
    expect(desktopPresence.isActive(T0 + L.desktopPresenceFreshMs + 1)).toBe(false);
  });

  it('未聚焦 → 不在场', () => {
    desktopPresence.report({ visible: true, focused: false, lastInputAt: T0 }, T0);
    expect(desktopPresence.isActive(T0)).toBe(false);
  });

  it('窗口隐藏 → 不在场', () => {
    desktopPresence.report({ visible: false, focused: true, lastInputAt: T0 }, T0);
    expect(desktopPresence.isActive(T0)).toBe(false);
  });

  it('最近输入时间过旧 → 不在场（人不在，窗口还开着不算数）', () => {
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0 - L.desktopPresenceFreshMs - 1 }, T0);
    expect(desktopPresence.isActive(T0)).toBe(false);
  });

  it('从未上报过 → 不在场（CLI / 无 renderer 场景，推送行为与之前一致）', async () => {
    vi.resetModules();
    const { desktopPresence: untouched } = await import('../../../src/host/services/companion/desktopPresence');
    expect(untouched.isActive(T0)).toBe(false);
    expect(untouched.lastViewedAt('presence-any')).toBe(null);
  });
});

describe('DesktopPresence.lastViewedAt', () => {
  it('记录会话被看到的最新时间；没看过的会话为 null', () => {
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0, viewingSessionId: 'presence-viewed-a' }, T0);
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0 + 5_000, viewingSessionId: 'presence-viewed-a' }, T0 + 5_000);
    expect(desktopPresence.lastViewedAt('presence-viewed-a')).toBe(T0 + 5_000);
    expect(desktopPresence.lastViewedAt('presence-never-viewed')).toBe(null);
  });

  it('乱序上报不回退已记录的时间（同一会话取最大）', () => {
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0 + 9_000, viewingSessionId: 'presence-viewed-b' }, T0 + 9_000);
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0 + 2_000, viewingSessionId: 'presence-viewed-b' }, T0 + 2_000);
    expect(desktopPresence.lastViewedAt('presence-viewed-b')).toBe(T0 + 9_000);
  });

  it('viewingSessionId 为空串/null 不计入已读表', () => {
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0, viewingSessionId: '' }, T0);
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0, viewingSessionId: null }, T0);
    expect(desktopPresence.lastViewedAt('')).toBe(null);
  });

  // r1 返修：单向已读只认「真在看」。renderer 心跳在窗口隐藏/失焦时仍每拍上报
  // viewingSessionId（它上报的是选中态），这些拍子不得盖章已读——否则重试等待期的
  // 完成推送会被后台心跳盖成 skipped（手机没收到、桌面也没人看，通知双丢）。
  it('r1 失焦/隐藏的心跳不写入已读表；回到前台（可见+聚焦）才盖章', () => {
    desktopPresence.report({ visible: true, focused: false, lastInputAt: T0, viewingSessionId: 'presence-blind-a' }, T0);
    expect(desktopPresence.lastViewedAt('presence-blind-a')).toBe(null);
    desktopPresence.report({ visible: false, focused: true, lastInputAt: T0 + 1_000, viewingSessionId: 'presence-blind-a' }, T0 + 1_000);
    expect(desktopPresence.lastViewedAt('presence-blind-a')).toBe(null);
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0 + 2_000, viewingSessionId: 'presence-blind-a' }, T0 + 2_000);
    expect(desktopPresence.lastViewedAt('presence-blind-a')).toBe(T0 + 2_000);
  });

  it('r1 失焦心跳不得推进已有已读时间（已读表不因后台拍子前进）', () => {
    desktopPresence.report({ visible: true, focused: true, lastInputAt: T0, viewingSessionId: 'presence-blind-b' }, T0);
    desktopPresence.report({ visible: true, focused: false, lastInputAt: T0 + 9_000, viewingSessionId: 'presence-blind-b' }, T0 + 9_000);
    expect(desktopPresence.lastViewedAt('presence-blind-b')).toBe(T0);
  });
});
