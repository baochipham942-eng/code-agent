// ============================================================================
// Switch 收敛棘轮：renderer 里禁止新增手搓 role="switch"，一律用 primitives/Toggle。
// 白名单只有 Toggle 本体 + KeybindingsSettings 的文字 pill 开关（刻意的另一形态，限 1 处）。
// 新增合法形态须在此登记并说明理由——报错必须指名道姓（gate-must-report-own-blindspot）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const RENDERER_DIR = path.resolve(__dirname, '../../../src/renderer');

/** 允许出现 role="switch" 的文件（相对 src/renderer）→ 允许的最大出现次数 */
const ALLOWLIST: Record<string, number> = {
  'components/primitives/Toggle.tsx': 1,
  // 文字 pill 形态的全局热键开关（带标签+状态点，非轨道式），刻意保留
  'components/features/settings/tabs/KeybindingsSettings.tsx': 1,
};

function grepSwitchSites(): Map<string, number> {
  let out = '';
  try {
    out = execFileSync('grep', ['-rn', 'role="switch"', RENDERER_DIR, '--include=*.tsx', '--include=*.ts'], {
      encoding: 'utf-8',
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    // grep exit 1 = 零命中（合法）；其他一律 fail-loud，不许静默当通过
    if (e.status === 1) return new Map();
    throw new Error(`switch 收敛门自身故障（grep exit ${e.status}）：${String(err)}`);
  }
  const counts = new Map<string, number>();
  for (const line of out.trim().split('\n')) {
    const file = path.relative(RENDERER_DIR, line.slice(0, line.indexOf(':')));
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

describe('Switch 收敛棘轮（手搓 role="switch" 只增不减白名单）', () => {
  it('白名单文件都仍存在对应数量的合法开关（防清单腐烂假绿）', () => {
    const counts = grepSwitchSites();
    for (const [file, max] of Object.entries(ALLOWLIST)) {
      expect(counts.get(file) ?? 0, `${file} 应恰有 ${max} 处 role="switch"（改动/删除需同步白名单）`).toBe(max);
    }
  });

  it('白名单之外零手搓 switch —— 新开关一律用 primitives/Toggle', () => {
    const counts = grepSwitchSites();
    const offenders = [...counts.entries()]
      .filter(([file, n]) => (ALLOWLIST[file] ?? 0) < n)
      .map(([file, n]) => `${file}: ${n} 处（允许 ${ALLOWLIST[file] ?? 0}）`);
    expect(offenders, `发现手搓 role="switch"，请改用 primitives/Toggle：\n${offenders.join('\n')}`).toEqual([]);
  });
});
