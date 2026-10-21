// ============================================================================
// daemon 空闲去留与设置默认值单测（ADR-083 ④/⑤）：
//   - shouldDaemonExit 表驱动：三信号（在跑 run / 配对伴侣 / 等审批）全空闲才随壳
//     退出，任何一项在忙就留守（拍板记录 2）。
//   - launchAtLogin 默认 false（拍板记录 2：登录自启默认关）；只测设置位，
//     LaunchAgent / 登录项的写入不在本刀范围（证据档附 grep 佐证）。
// 2026-10-18 append（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON）：
//   - daemonStayReasons 表驱动：armedSchedules 第四信号 + 壳声明的退出意图
//     （none / background / stop）五案例——armed 单独永不留守（none），只有
//     background+armed 才留守；stop 不构成留守原因，走 EOF 停机指令。
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  daemonStayReasons,
  shouldDaemonExit,
  type DaemonIdleSnapshot,
  type DaemonQuitIntent,
} from '../../../../../src/host/services/daemon/daemonIdle';
import {
  shouldStayResidentAfterShellExit,
  stdinEofIsQuitCommand,
} from '../../../../../src/host/services/daemon/shellExit';
import { DEFAULT_SETTINGS } from '../../../../../src/host/services/core/configDefaults';

describe('shouldDaemonExit（表驱动，ADR-083 ④）', () => {
  const cases: Array<{
    name: string;
    snapshot: { runningRuns: boolean; pairedCompanion: boolean; awaitingApproval: boolean };
    expected: boolean;
  }> = [
    { name: '全空闲 → 随壳退出', snapshot: { runningRuns: false, pairedCompanion: false, awaitingApproval: false }, expected: true },
    { name: '有在跑 run → 留守', snapshot: { runningRuns: true, pairedCompanion: false, awaitingApproval: false }, expected: false },
    { name: '配对伴侣在线 → 留守', snapshot: { runningRuns: false, pairedCompanion: true, awaitingApproval: false }, expected: false },
    { name: '有等审批 → 留守', snapshot: { runningRuns: false, pairedCompanion: false, awaitingApproval: true }, expected: false },
    { name: '三项全忙 → 留守', snapshot: { runningRuns: true, pairedCompanion: true, awaitingApproval: true }, expected: false },
    { name: 'run + 伴侣（无审批）→ 留守', snapshot: { runningRuns: true, pairedCompanion: true, awaitingApproval: false }, expected: false },
    { name: 'run + 审批（无伴侣）→ 留守', snapshot: { runningRuns: true, pairedCompanion: false, awaitingApproval: true }, expected: false },
    { name: '伴侣 + 审批（无 run）→ 留守', snapshot: { runningRuns: false, pairedCompanion: true, awaitingApproval: true }, expected: false },
  ];

  for (const { name, snapshot, expected } of cases) {
    it(name, () => {
      expect(shouldDaemonExit(snapshot)).toBe(expected);
    });
  }
});

describe('daemonStayReasons（表驱动，ADR-083 append 2026-10-18：armed schedules + 退出意图）', () => {
  const idleWith = (armedSchedules: number): DaemonIdleSnapshot => ({
    runningRuns: false, pairedCompanion: false, awaitingApproval: false, armedSchedules,
  });
  const busyArmed: DaemonIdleSnapshot = {
    runningRuns: true, pairedCompanion: false, awaitingApproval: false, armedSchedules: 2,
  };

  const cases: Array<{
    name: string;
    intent: DaemonQuitIntent;
    snapshot: DaemonIdleSnapshot;
    expectedReasons: string[];
    expectedStayAfterEof: boolean;
  }> = [
    { name: 'none + 0 armed + 空闲：随壳退出', intent: 'none', snapshot: idleWith(0), expectedReasons: [], expectedStayAfterEof: false },
    { name: 'none + >0 armed + 空闲：仍随壳退出（今日行为——armed 单独永不留守，壳崩不留隐形 daemon）', intent: 'none', snapshot: idleWith(3), expectedReasons: [], expectedStayAfterEof: false },
    { name: 'background + >0 armed + 空闲：留守（armed schedules 是留守原因）', intent: 'background', snapshot: idleWith(1), expectedReasons: ['armed-schedules'], expectedStayAfterEof: true },
    { name: 'background + 0 armed + 空闲：随壳退出（没任务就没理由留守）', intent: 'background', snapshot: idleWith(0), expectedReasons: [], expectedStayAfterEof: false },
    { name: 'stop + >0 armed + run 在忙：EOF 即优雅停机（stop 是停机指令，不留守）', intent: 'stop', snapshot: busyArmed, expectedReasons: ['running-runs'], expectedStayAfterEof: false },
  ];

  for (const { name, intent, snapshot, expectedReasons, expectedStayAfterEof } of cases) {
    it(name, () => {
      expect(daemonStayReasons(snapshot, intent)).toEqual(expectedReasons);
      // darwin（unix）口径下的 EOF 去留；background 已 arm detach，stop 全平台停机。
      const eofQuit = stdinEofIsQuitCommand('darwin', intent === 'background', intent);
      expect(shouldStayResidentAfterShellExit('darwin', snapshot, eofQuit, intent)).toBe(expectedStayAfterEof);
    });
  }

  it('stop 在任何平台都把 stdin EOF 变成停机指令（包括已 arm detach 的 win32）', () => {
    expect(stdinEofIsQuitCommand('darwin', false, 'stop')).toBe(true);
    expect(stdinEofIsQuitCommand('win32', true, 'stop')).toBe(true);
    expect(stdinEofIsQuitCommand('win32', false, 'none')).toBe(true);
    expect(stdinEofIsQuitCommand('darwin', false, 'none')).toBe(false);
  });
});

describe('daemon 设置默认值（ADR-083 ⑤）', () => {
  it('launchAtLogin 默认 false（登录自启默认关）', () => {
    expect(DEFAULT_SETTINGS.daemon?.launchAtLogin).toBe(false);
  });

  it('默认配置带全 daemon 组，存量配置可整组缺省（可选组）', () => {
    expect(DEFAULT_SETTINGS.daemon).toEqual({ launchAtLogin: false });
  });
});
