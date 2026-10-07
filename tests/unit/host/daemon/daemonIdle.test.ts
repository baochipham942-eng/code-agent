// ============================================================================
// daemon 空闲去留与设置默认值单测（ADR-083 ④/⑤）：
//   - shouldDaemonExit 表驱动：三信号（在跑 run / 配对伴侣 / 等审批）全空闲才随壳
//     退出，任何一项在忙就留守（拍板记录 2）。
//   - launchAtLogin 默认 false（拍板记录 2：登录自启默认关）；只测设置位，
//     LaunchAgent / 登录项的写入不在本刀范围（证据档附 grep 佐证）。
// ============================================================================

import { describe, expect, it } from 'vitest';

import { shouldDaemonExit } from '../../../../src/host/daemon/daemonIdle';
import { DEFAULT_SETTINGS } from '../../../../src/host/services/core/configDefaults';

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

describe('daemon 设置默认值（ADR-083 ⑤）', () => {
  it('launchAtLogin 默认 false（登录自启默认关）', () => {
    expect(DEFAULT_SETTINGS.daemon?.launchAtLogin).toBe(false);
  });

  it('默认配置带全 daemon 组，存量配置可整组缺省（可选组）', () => {
    expect(DEFAULT_SETTINGS.daemon).toEqual({ launchAtLogin: false });
  });
});
