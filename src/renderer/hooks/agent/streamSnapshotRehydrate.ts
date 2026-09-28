// ============================================================================
// streamSnapshotRehydrate — AGENT_STREAM_SNAPSHOT_REQUIRED 消费者的合并闸
//（N-STREAMSNAPSHOT-LOG-SPAM）
// ============================================================================

// 快照重灌信号在运行中可能逐事件触发：宿主侧有两套独立的 per-session seq 计数器
// （native: 与 http: 两个 epoch）喂同一个 renderer dispatcher，每次 epoch 翻转/序号
// 空洞都各自成信号。逐条翻译成全量 session load（switchSession force → 宿主
// decorateLoadedSession → loadStreamSnapshot 重扫 + INFO 落盘）真机可放大到每秒数次、
// 整轮刷屏（探针：100 事件 → 197 次 load）。重灌是恢复性动作：一次成功 load 已把
// 断点快照合回消息流，短窗口内重复 load 不带来新信息；窗口过后新信号照常触发，
// 恢复语义不变。
const STREAM_SNAPSHOT_REHYDRATE_MIN_INTERVAL_MS = 1500;

/**
 * 保留原有的会话过滤（信号指向别的会话不动当前会话），在此之上合并运行中的重复
 * 信号：重灌在途时丢弃后续信号；距上一次重灌发起不足 minIntervalMs 的迟到信号也
 * 丢弃——它们指向的缺口已被那一次 load 覆盖。首个信号永远立即触发，窗口过后新
 * 信号照常触发。注入 now/minIntervalMs 供测试控制时间。
 */
export function createStreamSnapshotRequiredHandler(deps: {
  getCurrentSessionId: () => string | null;
  reloadSession: (sessionId: string) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
}): (signal: { sessionId?: string }) => Promise<void> {
  const now = deps.now ?? Date.now;
  const minIntervalMs = deps.minIntervalMs ?? STREAM_SNAPSHOT_REHYDRATE_MIN_INTERVAL_MS;
  let reloading = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  return async ({ sessionId }) => {
    const current = deps.getCurrentSessionId();
    if (!current || (sessionId && sessionId !== current)) return;
    if (reloading) return;
    if (now() - lastStartedAt < minIntervalMs) return;
    reloading = true;
    lastStartedAt = now();
    try {
      await deps.reloadSession(current);
    } finally {
      reloading = false;
    }
  };
}
