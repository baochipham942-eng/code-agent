// ============================================================================
// 主操作按钮收敛棘轮：renderer 里禁止新增手搓 bg-blue-600/bg-blue-500 实心按钮
// 色，一律用 primitives/Button（variant="primary"/"danger"）或 Modal 的
// confirmColorClass 收敛源（BUTTON_PRIMARY_CLASS/BUTTON_DANGER_CLASS）。
// 白名单只留确认过的非按钮语义点（tab 高亮/状态点/进度条/调色板数组）和一处
// 记录在案的独立设计系统（UpdateNotification 的 pill CTA 状态机）。
// 新增合法形态须在此登记并说明理由——报错必须指名道姓（gate-must-report-own-blindspot）。
// 同套路照抄 settingsToggleConvergence.test.ts（PR #430）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const RENDERER_DIR = path.resolve(__dirname, '../../../src/renderer');
// lab 域是独立实验室 UI，整批排除（同批监工原话）
const LAB_DIR_MARKER = `${path.sep}lab${path.sep}`;

/** 允许出现实心 bg-blue-600/bg-blue-500 的文件（相对 src/renderer）→ 允许的最大出现次数 */
const ALLOWLIST: Record<string, number> = {
  // 更新弹窗自成一套 pill CTA 状态机（idle/downloading/downloaded/opened/error
  // 五态配色联动 blue/emerald/zinc，rounded-full + text-zinc-950），收敛进
  // Button primitive 会破坏这套状态色映射——记录为独立设计系统，本批不动。
  'components/UpdateNotification.tsx': 2,
  // 单选/多选项的选中指示圆点，不是按钮
  'components/MCPElicitationModal.tsx': 1,
  'components/UserQuestionModal.tsx': 1,
  // 下载进度条填充色
  'components/features/background/BackgroundSessionPanel.tsx': 1,
  // 分类调色板数组（用户活动分类打点色），非 UI 按钮
  'components/features/settings/sections/nativeDesktopActivityModel.ts': 1,
  // tab 选中态高亮 + 运行状态指示点，不是主操作按钮（已复核，见回报）
  'components/features/workflow/WorkflowPanel.tsx': 2,
  'components/features/workflow/DAGViewer.tsx': 1,
  'components/features/workflow/TaskNode.tsx': 1,
};

function grepPrimaryColorSites(): Map<string, number> {
  let out = '';
  try {
    out = execFileSync('grep', [
      '-rnE',
      'bg-blue-(600|500)([^/0-9a-zA-Z]|$)',
      RENDERER_DIR,
      '--include=*.tsx',
      '--include=*.ts',
    ], { encoding: 'utf-8' });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    // grep exit 1 = 零命中（合法）；其他一律 fail-loud，不许静默当通过
    if (e.status === 1) return new Map();
    throw new Error(`主操作色收敛门自身故障（grep exit ${e.status}）：${String(err)}`);
  }
  const counts = new Map<string, number>();
  for (const line of out.trim().split('\n')) {
    if (!line) continue;
    const filePath = line.slice(0, line.indexOf(':'));
    if (filePath.includes(LAB_DIR_MARKER)) continue; // lab 域整批排除
    const file = path.relative(RENDERER_DIR, filePath);
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

describe('主操作按钮收敛棘轮（手搓 bg-blue-600/500 只增不减白名单）', () => {
  it('白名单文件都仍存在对应数量的命中（防清单腐烂假绿）', () => {
    const counts = grepPrimaryColorSites();
    for (const [file, max] of Object.entries(ALLOWLIST)) {
      expect(counts.get(file) ?? 0, `${file} 应恰有 ${max} 处（改动/删除需同步白名单）`).toBe(max);
    }
  });

  it('白名单之外零手搓主操作色——新按钮一律用 primitives/Button', () => {
    const counts = grepPrimaryColorSites();
    const offenders = [...counts.entries()]
      .filter(([file, n]) => (ALLOWLIST[file] ?? 0) < n)
      .map(([file, n]) => `${file}: ${n} 处（允许 ${ALLOWLIST[file] ?? 0}）`);
    expect(offenders, `发现手搓主操作色，请改用 primitives/Button：\n${offenders.join('\n')}`).toEqual([]);
  });
});
