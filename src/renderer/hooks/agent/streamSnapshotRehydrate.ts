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
 * 信号：重灌在途或距上一次发起不足 minIntervalMs 时不立即重灌，而是挂一次尾随
 * 重灌（窗口内多条信号只挂一次）——保证窗口里最后那条缺口也会被补上，不会停在
 * 旧内容。首个信号永远立即触发。注入 now/minIntervalMs/schedule 供测试控制时间。
 */
export function createStreamSnapshotRequiredHandler(deps: {
  getCurrentSessionId: () => string | null;
  reloadSession: (sessionId: string) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
  schedule?: (run: () => void, delayMs: number) => void;
}): (signal: { sessionId?: string }) => Promise<void> {
  const now = deps.now ?? Date.now;
  const minIntervalMs = deps.minIntervalMs ?? STREAM_SNAPSHOT_REHYDRATE_MIN_INTERVAL_MS;
  const schedule = deps.schedule ?? ((run, delayMs) => { setTimeout(run, delayMs); });
  let reloading = false;
  let trailingScheduled = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  const handle = async ({ sessionId }: { sessionId?: string }): Promise<void> => {
    const current = deps.getCurrentSessionId();
    if (!current || (sessionId && sessionId !== current)) return;
    const waitMs = reloading ? minIntervalMs : lastStartedAt + minIntervalMs - now();
    if (waitMs > 0) {
      if (!trailingScheduled) {
        trailingScheduled = true;
        schedule(() => {
          trailingScheduled = false;
          void handle({});
        }, waitMs);
      }
      return;
    }
    reloading = true;
    lastStartedAt = now();
    try {
      await deps.reloadSession(current);
    } finally {
      reloading = false;
    }
  };
  return handle;
}
