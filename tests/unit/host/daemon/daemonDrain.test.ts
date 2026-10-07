// ============================================================================
// drainAndStop 单测（ADR-083 ③）：`neo daemon stop` 触发的排空语义
//   - 未决 op 已归零：立即返回 drained，零日志。
//   - 宽限内归零：等到 drained，不强停。
//   - 宽限耗尽仍归不了零：强停（fake op 被 forceStop 收口）并留痕。
//   - drainPendingOpsForShutdown：壳看门狗在时套 withCap（预算封顶优先于宽限），
//     无看门狗时用完整宽限、不套 cap。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';

import { drainAndStop, drainPendingOpsForShutdown } from '../../../../src/host/daemon/daemonDrain';
import { WEB_DAEMON } from '../../../../src/shared/constants/webServer';

describe('drainAndStop', () => {
  it('入口处未决已归零 → 立即 drained，不轮询不强停', async () => {
    const forceStop = vi.fn();
    const log = vi.fn();
    const outcome = await drainAndStop({ getPendingOps: () => 0, graceMs: 1_000, forceStop, log });
    expect(outcome).toBe('drained');
    expect(forceStop).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('宽限内未决归零（fake op 被收口）→ drained，stop 语义 = 等到自然收口', async () => {
    let pending = 1;
    const getPendingOps = vi.fn(() => pending);
    // 第 2 次轮询前把 fake op 收口，模拟 run 自然结束。
    setTimeout(() => { pending = 0; }, 30);
    const outcome = await drainAndStop({
      getPendingOps,
      graceMs: 5_000,
      forceStop: vi.fn(),
      log: vi.fn(),
      pollIntervalMs: 20,
    });
    expect(outcome).toBe('drained');
    expect(getPendingOps.mock.calls.length).toBeGreaterThan(1);
  });

  it('宽限耗尽仍有未决 → force-stop 收口 fake op 并留痕（ADR-083 ③）', async () => {
    const log = vi.fn();
    let pending = 3;
    const forceStop = vi.fn(() => { pending = 0; });
    const outcome = await drainAndStop({
      getPendingOps: () => pending,
      graceMs: 60,
      forceStop,
      log,
      pollIntervalMs: 20,
    });
    expect(outcome).toBe('force-stopped');
    expect(forceStop).toHaveBeenCalledTimes(1);
    // 留痕必须带未决数与宽限值：事后判「这次为什么强停」靠这行。
    expect(log).toHaveBeenCalledWith(expect.stringContaining('force-stopping'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('3 pending op(s)'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('60ms'));
  });
});

describe('drainPendingOpsForShutdown（webServer 停机步骤的宽限分档）', () => {
  it('壳看门狗在：宽限压到 UNDER_SHELL 档并套 withCap', async () => {
    const withCap = vi.fn(<T,>(p: Promise<T>) => p);
    await drainPendingOpsForShutdown({
      getPendingOps: () => 0,
      watchdogActive: true,
      withCap,
    });
    expect(withCap).toHaveBeenCalledTimes(1);
    expect(withCap.mock.calls[0][1]).toBe('daemon.drain');
  });

  it('无看门狗：不套 withCap（完整宽限等排空，没有 SIGKILL 在后面追）', async () => {
    const withCap = vi.fn(<T,>(p: Promise<T>) => p);
    let pending = 1;
    setTimeout(() => { pending = 0; }, 30);
    await drainPendingOpsForShutdown({
      getPendingOps: () => pending,
      watchdogActive: false,
      withCap,
      log: vi.fn(),
    });
    expect(withCap).not.toHaveBeenCalled();
  });

  it('宽限档位关系：壳档 ≤ 完整档，stop 等待 ≥ 完整宽限（排空要等得完）', () => {
    expect(WEB_DAEMON.DRAIN_GRACE_UNDER_SHELL_MS).toBeLessThanOrEqual(WEB_DAEMON.DRAIN_GRACE_MS);
    expect(WEB_DAEMON.STOP_WAIT_MS).toBeGreaterThanOrEqual(WEB_DAEMON.DRAIN_GRACE_MS);
    // 壳档必须留在关库预算量级内（Rust 侧 3s SIGKILL 看门狗，见 webShutdownFinalizers 头注）。
    expect(WEB_DAEMON.DRAIN_GRACE_UNDER_SHELL_MS).toBeLessThanOrEqual(2_000);
  });
});
