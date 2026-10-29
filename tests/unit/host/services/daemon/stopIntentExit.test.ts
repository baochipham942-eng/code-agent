// ============================================================================
// 「停止并退出」意图 → daemon 自行排空退出（N-QUIT-STOP-DAEMON-FIX-FU1）
// ----------------------------------------------------------------------------
// 两条缺口各一组：
//   ① 附着 daemon（stdin 管道早已断开，不会再有 EOF 事件）：intent=stop 的意图
//      变化本身必须触发去留重查（daemonStateReporter 联动 recheck）→ 排空停机。
//      none / background 不触发（background 的去留仍由空闲判据说了算）。
//   ② owned 子进程的停机编排：EOF + intent=stop 后 drainPendingOpsForShutdown
//      走无看门狗档（isDrainWatchdogActive(false) = false），两个 fake run 跨过
//      壳档 1s 宽限全部等完；对照档（管道仍在）在同一时点已把第二个 run 强停。
// 意图是 quitIntent.ts 的进程级单例：同一 it 内按 none→background→stop 排序推进，
// 只依赖「变化才通知」的幂等语义。
// ============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { drainPendingOpsForShutdown, isDrainWatchdogActive } from '../../../../../src/host/services/daemon/daemonDrain';
import { createDaemonResidencyReporter } from '../../../../../src/host/services/daemon/daemonStateReporter';
import type { DaemonIdleSnapshot } from '../../../../../src/host/services/daemon/daemonIdle';
import { getDaemonQuitIntent, setDaemonQuitIntent } from '../../../../../src/host/services/daemon/quitIntent';
import { createDaemonExitRechecker } from '../../../../../src/host/services/daemon/shellExit';

const busySnapshot: DaemonIdleSnapshot = {
  runningRuns: true,
  pairedCompanion: false,
  awaitingApproval: false,
  armedSchedules: 1,
};

const passthroughWithCap = <T>(p: Promise<T>): Promise<T | void> => p;

describe('intent=stop 触发已断管 daemon 的去留重查（FU1 ①：附着 daemon 的停止通道）', () => {
  it('管道已断：none / background 不触发停机，stop 恰好触发一次', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-stop-intent-exit-'));
    const shutdown = vi.fn();
    const rechecker = createDaemonExitRechecker({
      platform: 'darwin',
      getSnapshot: () => busySnapshot,
      shutdown,
      getQuitIntent: getDaemonQuitIntent,
    });
    const recheck = vi.fn(() => rechecker.recheck());
    createDaemonResidencyReporter({ dataDir, getSnapshot: () => busySnapshot, recheck });

    // 管道断开（上一任壳已死）+ 在跑 run + intent=none：留守，不触发停机。
    expect(rechecker.onShellPipeClosed()).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();

    // background：意图变化只重写状态文件，去留仍由空闲判据决定（在跑 → 留守）。
    setDaemonQuitIntent('background');
    expect(recheck).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();

    // stop：意图变化本身触发 recheck → 排空停机（附着 daemon 没有 EOF 可等）。
    setDaemonQuitIntent('stop');
    expect(recheck).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();

    // 之后的意图变化不会二次停机（shutdownStarted 自守卫）。
    setDaemonQuitIntent('background');
    expect(shutdown).toHaveBeenCalledOnce();
  });
});

describe('EOF + intent=stop 的排空档位（FU1 ②：两个 run 都等完再停机）', () => {
  it('无看门狗档：跨过壳档 1s 宽限，等完两个 run 才完成 shutdown', async () => {
    // 与 webServer.shutdown 相同的编排：EOF 先把 shellPipeAttached 置 false，
    // drain 档位经 isDrainWatchdogActive 流入（macOS/Linux 管道断 = 无看门狗）。
    setDaemonQuitIntent('stop');
    let shellPipeAttached = true;
    let pending = 2;
    let shutdownDone = false;
    const log = vi.fn();
    const shutdown = async (): Promise<void> => {
      await drainPendingOpsForShutdown({
        getPendingOps: () => pending,
        watchdogActive: isDrainWatchdogActive(shellPipeAttached),
        withCap: passthroughWithCap,
        log,
      });
      shutdownDone = true;
    };
    const rechecker = createDaemonExitRechecker({
      platform: 'darwin',
      getSnapshot: () => busySnapshot,
      shutdown,
      getQuitIntent: getDaemonQuitIntent,
    });

    // fake runs：第一个 ~600ms 收口，第二个 ~1600ms 收口（都跨过壳档 1s 宽限的
    // 「至少第二个跨过」判据；第一个留在线内让「等完两个」有区分度）。
    setTimeout(() => { pending = 1; }, 600);
    setTimeout(() => { pending = 0; }, 1600);

    shellPipeAttached = false; // stdin EOF（壳在意图落地后关写端）
    const startedAt = Date.now();
    expect(rechecker.onShellPipeClosed()).toBe(true); // intent=stop → 立即触发停机
    await vi.waitFor(() => expect(shutdownDone).toBe(true), { timeout: 10_000 });

    const elapsed = Date.now() - startedAt;
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).not.toContain('force'); // 没有被强停：两个 run 都自然收口
    expect(elapsed).toBeGreaterThanOrEqual(1500); // 等到了第二个 run（>1s 壳档宽限）
    expect(elapsed).toBeLessThan(10_000); // 确实是等完收口，不是耗到 60s 完整宽限
  }, 15_000);

  it('对照档：同一时刻若管道仍在（看门狗档），第二个 run 会被 1s 宽限强停', async () => {
    // 这条对照钉住「档位选择就是救命的那一环」：SIGTERM 旧通道（管道未断）在同
    // 一收口节奏下必然强停——所以新通道的第一步必须是 EOF（断管）而不是 SIGTERM。
    let pending = 2;
    const log = vi.fn();
    setTimeout(() => { pending = 1; }, 600);
    setTimeout(() => { pending = 0; }, 1600);

    await drainPendingOpsForShutdown({
      getPendingOps: () => pending,
      watchdogActive: isDrainWatchdogActive(true), // 管道仍在 = 壳 3s SIGKILL 还挂着
      withCap: passthroughWithCap,
      log,
    });

    const logged = log.mock.calls.flat().join('\n');
    expect(logged).toContain('exceeded with 1 pending op(s)');
    expect(logged).toContain('force-stopping');
  }, 10_000);
});
