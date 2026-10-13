// ============================================================================
// daemon 排空单测（ADR-083 ③）：`neo daemon stop` 触发的排空语义，走生产唯一
// 出口 drainPendingOpsForShutdown（排空引擎 drainAndStop 是模块内部件）。
//   - 未决 op 归零（入口即零 / 宽限内收口）→ 不强停、零「force」日志。
//   - 宽限耗尽仍归不了零 → 强停并留痕（fake op 的未决数进日志）。
//   - 壳看门狗在时套 withCap（预算封顶优先于宽限），无看门狗不套。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';

import { drainPendingOpsForShutdown, isDrainWatchdogActive } from '../../../../../src/host/services/daemon/daemonDrain';
import { WEB_DAEMON } from '../../../../../src/shared/constants/webServer';

/** withCap 侦查件：手写闭包记录调用（vi.fn 对泛型签名的 Mock 类型对不上真签名）。 */
function spyWithCap(): { withCap: <T>(p: Promise<T>, label: string) => Promise<T | void>; calls: Array<[Promise<unknown>, string]> } {
  const calls: Array<[Promise<unknown>, string]> = [];
  return {
    calls,
    withCap: <T,>(p: Promise<T>, label: string): Promise<T | void> => {
      calls.push([p, label]);
      return p;
    },
  };
}

describe('drainPendingOpsForShutdown（ADR-083 ③ 排空语义）', () => {

  it('入口处未决已归零 → 立即返回，零日志（正常空闲停机零延迟）', async () => {
    const log = vi.fn();
    const spy = spyWithCap();
    await drainPendingOpsForShutdown({ getPendingOps: () => 0, watchdogActive: false, withCap: spy.withCap, log });
    expect(log).not.toHaveBeenCalled();
  });

  it('宽限内未决归零（fake op 被收口）→ 等到自然收口，不强停（stop = 等排空）', async () => {
    const log = vi.fn();
    let pending = 1;
    setTimeout(() => { pending = 0; }, 30);
    const startedAt = Date.now();
    await drainPendingOpsForShutdown({
      getPendingOps: () => pending,
      watchdogActive: false,
      withCap: spyWithCap().withCap,
      log,
    });
    expect(Date.now() - startedAt).toBeLessThan(WEB_DAEMON.DRAIN_GRACE_MS);
    expect(log.mock.calls.flat().join('\n')).not.toContain('force');
  });

  it('宽限耗尽仍有未决 → 强停并留痕：未决数与强停动作都进日志（ADR-083 ③）', async () => {
    const log = vi.fn();
    const spy = spyWithCap();
    const startedAt = Date.now();
    // 壳看门狗档 = DRAIN_GRACE_UNDER_SHELL_MS，测试等得起；withCap 用直通侦查件，
    // 让排空引擎自己走到宽限终点（真 webServer 里 withCap 只会更早截断，同样安全）。
    await drainPendingOpsForShutdown({
      getPendingOps: () => 3,
      watchdogActive: true,
      withCap: spy.withCap,
      log,
    });
    const logged = log.mock.calls.flat().join('\n');
    // 强停不会早于宽限（引擎先比时间再强停）。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(WEB_DAEMON.DRAIN_GRACE_UNDER_SHELL_MS - 50);
    expect(logged).toContain('exceeded with 3 pending op(s)');
    expect(logged).toContain('force-stopping');
    expect(logged).toContain('cancellation follows in the reap step');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0][1]).toBe('daemon.drain');
  }, 10_000);

  it('无看门狗：不套 withCap（完整宽限等排空，没有 SIGKILL 在后面追）', async () => {
    const spy = spyWithCap();
    let pending = 1;
    setTimeout(() => { pending = 0; }, 30);
    await drainPendingOpsForShutdown({
      getPendingOps: () => pending,
      watchdogActive: false,
      withCap: spy.withCap,
      log: vi.fn(),
    });
    expect(spy.calls).toHaveLength(0);
  });

  it('宽限档位关系：壳档 ≤ 完整档，stop 等待 ≥ 完整宽限（排空要等得完）', () => {
    expect(WEB_DAEMON.DRAIN_GRACE_UNDER_SHELL_MS).toBeLessThanOrEqual(WEB_DAEMON.DRAIN_GRACE_MS);
    expect(WEB_DAEMON.STOP_WAIT_MS).toBeGreaterThanOrEqual(WEB_DAEMON.DRAIN_GRACE_MS);
    // 壳档必须留在关库预算量级内（Rust 侧 3s SIGKILL 看门狗，见 webShutdownFinalizers 头注）。
    expect(WEB_DAEMON.DRAIN_GRACE_UNDER_SHELL_MS).toBeLessThanOrEqual(2_000);
  });
});

// ── win32 EOF 停机档位（返修 2026-10-13 Important 1）─────────────────────────
// win32 的 stdin EOF 是 Rust「请退出」指令（terminate_child 关写端，3s 后
// TerminateProcess），管道断开恰恰意味着看门狗刚启动——EOF 触发的停机必须留在
// 带 cap 的看门狗档，否则完整宽限被拦腰截断、关库轮不到（陈旧 -wal/-shm）。
// 调用点接线由 tests/unit/main/gracefulShutdown.static.test.ts 钉住（win32 分支
// 在 mac/linux 机器上跑不出运行时行为），这里测档位判据本身 + 判据流入 drain 的档位。
describe('isDrainWatchdogActive（win32 EOF 停机留在看门狗档）', () => {
  const originalPlatform = process.platform;
  function stubPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
  afterEach(() => {
    stubPlatform(originalPlatform);
  });

  it('win32：管道已断（EOF 触发停机）仍在看门狗档；管道在自然也在', () => {
    stubPlatform('win32');
    expect(isDrainWatchdogActive(false)).toBe(true);
    expect(isDrainWatchdogActive(true)).toBe(true);
  });

  it('darwin / linux：管道断开 = 壳已死，看门狗确实没了；管道在 = 还挂着', () => {
    stubPlatform('darwin');
    expect(isDrainWatchdogActive(false)).toBe(false);
    expect(isDrainWatchdogActive(true)).toBe(true);
    stubPlatform('linux');
    expect(isDrainWatchdogActive(false)).toBe(false);
    expect(isDrainWatchdogActive(true)).toBe(true);
  });

  it('档位经判据流入 drain：win32 EOF（管道断）也套 withCap（带 cap 档）', async () => {
    stubPlatform('win32');
    const spy = spyWithCap();
    await drainPendingOpsForShutdown({
      getPendingOps: () => 0,
      watchdogActive: isDrainWatchdogActive(false),
      withCap: spy.withCap,
      log: vi.fn(),
    });
    expect(spy.calls.map(([, label]) => label)).toEqual(['daemon.drain']);
  });

  it('档位经判据流入 drain：darwin 管道断（壳已死）不套 withCap（完整宽限档）', async () => {
    stubPlatform('darwin');
    const spy = spyWithCap();
    await drainPendingOpsForShutdown({
      getPendingOps: () => 0,
      watchdogActive: isDrainWatchdogActive(false),
      withCap: spy.withCap,
      log: vi.fn(),
    });
    expect(spy.calls).toHaveLength(0);
  });
});
