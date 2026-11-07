// ============================================================================
// Desktop Presence — 桌面在场信号（N-NOTIFY-PRESENCE-HEARTBEAT）
// ============================================================================
//
// renderer 每 COMPANION_LIMITS.desktopPresenceHeartbeatMs 上报一次（窗口可见 + 聚焦 +
// 最近输入 + 正在看的会话），CompanionPushOutbox 据此抑制普通推送（agent_complete /
// agent_cancelled）：用户就坐在电脑前时，手机不再为「跑完了」震动。approval / error
// 紧急类永不在乎在场信号——该到的照旧到。
//
// 纯内存、无 I/O；时钟可注入（构造 deps.now，或每个方法显式传 now，单测不依赖真实时间）。
// 边界（任务书钉死）：不做系统 idle / 锁屏检测，不做手机→桌面已读同步——那是后续真机单。

import { COMPANION_LIMITS } from '../../../shared/constants/companion';

/** 一条在场上报的载荷形状（renderer → notification IPC reportPresence，schema 同形）。 */
interface DesktopPresenceReport {
  visible: boolean;
  focused: boolean;
  lastInputAt: number;
  viewingSessionId?: string | null;
}

/** CompanionPushOutbox 消费的最小面：抑制判定 + 单向已读。 */
export interface DesktopPresenceProbe {
  /** 用户此刻是否在电脑前（窗内、可见、聚焦、最近输入也在窗内）。 */
  isActive(now: number): boolean;
  /** 会话最近一次被看到（窗口可见+聚焦时的上报）的时间戳；从未看过为 null。 */
  lastViewedAt(sessionId: string): number | null;
}

class DesktopPresence implements DesktopPresenceProbe {
  private readonly now: () => number;
  private latest: (DesktopPresenceReport & { receivedAt: number }) | null = null;
  private readonly viewedAt = new Map<string, number>();

  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? Date.now;
  }

  /** 记一条 renderer 上报；now 显式可注入（IPC 通道缺省用实例时钟）。 */
  report(input: DesktopPresenceReport, now = this.now()): void {
    this.latest = { ...input, receivedAt: now };
    // 单向已读只认「真在看」：隐藏/失焦的心跳照样带 viewingSessionId（renderer 上报的是
    // 选中态，不是注视态），这些拍子不得盖章已读——否则重试等待期的完成推送会被后台
    // 心跳盖成 skipped，手机没收到、桌面也没人看，通知双丢。
    const sessionId = input.viewingSessionId;
    if (input.visible && input.focused && typeof sessionId === 'string' && sessionId) {
      const prev = this.viewedAt.get(sessionId);
      if (prev === undefined || now >= prev) this.viewedAt.set(sessionId, now);
    }
  }

  /**
   * 在场 = 报告存在且本身在新鲜窗内、窗口可见且聚焦、最近输入也在窗内。任一不满足即
   * false——抑制是优化，误判「在场」的代价是漏推，宁可多推。
   */
  isActive(now = this.now()): boolean {
    const report = this.latest;
    if (!report) return false;
    if (!report.visible || !report.focused) return false;
    if (now - report.receivedAt > COMPANION_LIMITS.desktopPresenceFreshMs) return false;
    return now - report.lastInputAt <= COMPANION_LIMITS.desktopPresenceFreshMs;
  }

  /** 单向已读：桌面在 created_at 之后看过该会话，还在 pending 的手机推送就不发了。 */
  lastViewedAt(sessionId: string): number | null {
    const at = this.viewedAt.get(sessionId);
    return at === undefined ? null : at;
  }
}

/** 进程内唯一实例：notification IPC 的 reportPresence 写入，web/app.ts 装配进 CompanionPushOutbox。 */
export const desktopPresence = new DesktopPresence();
