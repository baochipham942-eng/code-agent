// ============================================================================
// shellExit 单测（返修 Important 1）：壳退出后驻留判据的平台分叉。
//   - Windows：Rust terminate_child 用「关 stdin 写端」表示「请退出」（3s 后
//     TerminateProcess 兜底）——stdin EOF 在那边是停机指令，不是「没人再杀
//     我们」。win32 一律不留守（false = 走优雅停机），忙也一样，否则优雅停机
//     退化为被硬杀（回归）。
//   - macOS/Linux：交给空闲判据——忙则留守，全空闲/拿不到快照则随壳退出。
//   - 接线静态钉：webServer 的 onShellPipeClosed 必须把 process.platform 喂给
//     本判据、false 路径必须落到 shutdown()——本地/CI 都在 mac 上跑，win32
//     分支真机不可达，只能这样钉（同 gracefulShutdown T1 静态门的口径）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createDaemonExitRechecker,
  shouldStayResidentAfterShellExit,
} from '../../../../../src/host/services/daemon/shellExit';
import { RunRegistry } from '../../../../../src/host/runtime/runRegistry';

const busy = { runningRuns: true, pairedCompanion: false, awaitingApproval: false };
const allBusy = { runningRuns: true, pairedCompanion: true, awaitingApproval: true };
const idle = { runningRuns: false, pairedCompanion: false, awaitingApproval: false };

describe('shouldStayResidentAfterShellExit（表驱动，返修 Important 1）', () => {
  const cases: Array<{
    name: string;
    platform: NodeJS.Platform;
    snapshot: { runningRuns: boolean; pairedCompanion: boolean; awaitingApproval: boolean } | undefined;
    expected: boolean;
  }> = [
    { name: 'win32 + 在跑 run：不留守，stdin EOF 走停机（Rust 关 stdin = 请退出）', platform: 'win32', snapshot: busy, expected: false },
    { name: 'win32 + 三项全忙：仍不留守（忙时驻留会耗在被 TerminateProcess 硬杀上）', platform: 'win32', snapshot: allBusy, expected: false },
    { name: 'win32 + 全空闲：不留守（同 origin/main：EOF 一律停机）', platform: 'win32', snapshot: idle, expected: false },
    { name: 'win32 + 拿不到快照：不留守', platform: 'win32', snapshot: undefined, expected: false },
    { name: 'darwin + 在跑 run：留守', platform: 'darwin', snapshot: busy, expected: true },
    { name: 'linux + 三项全忙：留守', platform: 'linux', snapshot: allBusy, expected: true },
    { name: 'darwin + 全空闲：随壳退出', platform: 'darwin', snapshot: idle, expected: false },
    { name: 'darwin + 拿不到快照（app 未接线）：随壳退出', platform: 'darwin', snapshot: undefined, expected: false },
  ];

  for (const { name, platform, snapshot, expected } of cases) {
    it(name, () => {
      expect(shouldStayResidentAfterShellExit(platform, snapshot)).toBe(expected);
    });
  }
});

describe('webServer 接线（静态钉，win32 真机不可达）', () => {
  it('onShellPipeClosed 把 process.platform 喂给驻留判据，false 路径落到 shutdown()', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/web/webServer.ts'), 'utf8');
    const callback = /const onShellPipeClosed = \(\) => \{[\s\S]*?\n {2}\};/.exec(src);
    expect(callback, 'onShellPipeClosed 回调锚点失效').not.toBeNull();
    expect(callback![0]).toContain('shouldStayResidentAfterShellExit(process.platform');
    expect(callback![0]).toMatch(/void shutdown\(\)/);
  });
});

describe('createDaemonExitRechecker（返修 Important 1 回归）', () => {
  it('壳管道先断开时留守；run 终态变为空闲后走 shutdown', () => {
    let snapshot = busy;
    const shutdown = vi.fn();
    const runRegistry = new RunRegistry();
    const runHandle = runRegistry.start({ sessionId: 'rework-session', workspace: process.cwd() });
    const rechecker = createDaemonExitRechecker({
      platform: 'darwin',
      getSnapshot: () => snapshot,
      shutdown,
    });
    runRegistry.onIdleTransition(rechecker.recheck);

    expect(rechecker.onShellPipeClosed()).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();

    snapshot = idle;
    expect(runRegistry.unregister(runHandle.context.runId, runHandle)).toBe(true);
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
