// ============================================================================
// Daemon Drain — ADR-083 常驻宿主的优雅停排空
// ============================================================================
// 优雅停（SIGTERM / `neo daemon stop`）先给在跑的 run 一个自然收口的窗口：
// 轮询未决 op 数，归零即算排空完成；宽限耗尽仍归不了零就强停并留痕——强停指
// 「不再等、继续走停机序列里的取消步骤」（shutdownReaper 收尸），恢复语义由
// ADR-075 的 crash_or_quit sweep 兜底，不在本模块重复实现。
//
// 宽限分两档（WEB_DAEMON）：壳的 3s SIGKILL 看门狗还挂着时（被 Tauri spawn 且
// stdin 管道未断）压进关库预算内；无看门狗（独立 daemon / 壳已死 / neo daemon
// stop）才用完整宽限。分档在 drainPendingOpsForShutdown 里做，调用方
// （webServer.shutdown）只需传一个 watchdogActive 布尔。
// ============================================================================

import { WEB_DAEMON } from '../../shared/constants/webServer';

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

interface DaemonDrainDeps {
  /** 当前未决 op 数（0 = 已收口）。口径由调用方定：webServer 用「在跑 run」信号。 */
  getPendingOps: () => number;
  /** 宽限（ms）。到期仍有未决 op → 强停。 */
  graceMs: number;
  /** 强停动作。排空超时后调用一次；停机序列里的真取消由调用方接线。 */
  forceStop: () => void | Promise<void>;
  log: (message: string) => void;
  /** 轮询间隔（ms），缺省 WEB_DAEMON.POLL_INTERVAL_MS。 */
  pollIntervalMs?: number;
}

/**
 * 排空引擎（模块内部）：等未决 op 归零（'drained'），或宽限耗尽后强停并留痕
 * （'force-stopped'）。入口处未决已为 0 时立即返回，正常空闲停机零延迟零日志。
 */
async function drainAndStop(deps: DaemonDrainDeps): Promise<'drained' | 'force-stopped'> {
  const pollMs = deps.pollIntervalMs ?? WEB_DAEMON.POLL_INTERVAL_MS;
  const startedAt = Date.now();
  for (;;) {
    const pending = deps.getPendingOps();
    if (pending <= 0) return 'drained';
    if (Date.now() - startedAt >= deps.graceMs) {
      deps.log(`[daemon] drain grace (${deps.graceMs}ms) exceeded with ${pending} pending op(s); force-stopping`);
      await deps.forceStop();
      return 'force-stopped';
    }
    await delay(pollMs);
  }
}

/**
 * webServer.shutdown 的排空步骤（模块唯一出口）：按「壳看门狗是否还挂着」选宽限
 * 档位，看门狗在时还要套 withCap（关库前步骤的预算封顶器）——排空绝不允许吃穿
 * 关库预算（Rust 侧 3s 到点 SIGKILL，陈旧 -wal/-shm 的老坑见 webShutdownFinalizers
 * 头注）。
 */
export function drainPendingOpsForShutdown(deps: {
  getPendingOps: () => number;
  watchdogActive: boolean;
  withCap: <T>(p: Promise<T>, label: string) => Promise<T | void>;
  log?: (message: string) => void;
}): Promise<void> {
  const log = deps.log ?? console.log;
  const drain = drainAndStop({
    getPendingOps: deps.getPendingOps,
    graceMs: deps.watchdogActive ? WEB_DAEMON.DRAIN_GRACE_UNDER_SHELL_MS : WEB_DAEMON.DRAIN_GRACE_MS,
    forceStop: () => {
      // 留痕即「记录强停」；真正的取消由紧随其后的 reapChildProcesses 停机步骤执行，
      // 这里不重复收一遍（收尸清单见 webServer.shutdown）。
      log('[daemon] force-stopping pending runs; cancellation follows in the reap step');
    },
    log,
  });
  return (deps.watchdogActive
    ? deps.withCap(drain, 'daemon.drain')
    : drain) as Promise<void>;
}
