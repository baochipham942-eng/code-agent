// ============================================================================
// 表面色 token 收敛棘轮：chat 域 + TitleBar 已清扫完的文件里，禁止再出现手搓
// white-alpha（`bg-white/[0.06]` / `border-white/10` / `ring-white/[0.06]`
// 三种 utility 形态），一律用已注册的六 token：surface-faint/surface-subtle/
// surface-hover + border-faint/border-muted/border-hover（tailwind.config.js
// 里六 token 都注册在 colors 下，ring-* 同样可用；styles/themes/*.css 定义
// 具体值）。按 utility 形态枚举（bg|border|ring）而不是按文件名枚举，新增
// 形态（如未来出现 divide-white/shadow-white）需要同步扩这里的正则。
// 清单只覆盖本批清扫过的文件——不扫全仓，别的组件/域不归这道门管。
// 白名单登记 3 处刻意保留的字面量（映射后档位跳档明显，宁可少动）。
// 同套路照抄 settingsToggleConvergence.test.ts（PR #430）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RENDERER_DIR = path.resolve(__dirname, '../../../src/renderer');

/** 本批清扫过的文件（相对 src/renderer）——门只管这些，不扫全域 */
const SCOPED_FILES = [
  'components/features/chat/RouteTraceChip.tsx',
  // AssistantMessage.tsx 已被 #452（chore/tool output leftovers）删除，功能拆并到
  // MessageBubble/ 其他文件，未留下 white-alpha 残留——按门自身的清单维护政策同步移除。
  'components/features/chat/MessageBubble/DeliverableCardList.tsx',
  'components/features/chat/MessageBubble/messageContentParts.tsx',
  'components/features/chat/MessageBubble/MediaAssetControls.tsx',
  'components/features/chat/MessageBubble/FileArtifactCard.tsx',
  'components/features/chat/PinnedTodoBar.tsx',
  'components/features/chat/TurnQualityStrip.tsx',
  'components/features/chat/TurnCard.tsx',
  'components/features/chat/SessionDiffSummary.tsx',
  'components/features/chat/InlineWorkbenchBar.tsx',
  'components/features/chat/ContextUsagePill.tsx',
  'components/features/chat/TraceNodeRenderer.tsx',
  'components/features/chat/InlineStrip.tsx',
  'components/TitleBar.tsx',
];

/** 允许残留手搓 white-alpha 的文件（相对 src/renderer）→ 允许的最大出现次数。
 * 映射到最近 token 后档位跳档明显（相对误差 >35%，且没有更近的 token 可选），
 * 保留原字面量以保证「视觉终态无可感变化」。 */
const ALLOWLIST: Record<string, number> = {
  'components/features/chat/MessageBubble/messageContentParts.tsx': 1, // hover:bg-white/[0.1]，离 surface-hover(0.05) 太远
  'components/features/chat/ContextUsagePill.tsx': 1, // hover:bg-white/[0.1]，同上
  'components/features/chat/InlineStrip.tsx': 1, // bg-white/[0.08]，离 surface-hover(0.05) 太远
};

function grepWhiteAlphaSites(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rel of SCOPED_FILES) {
    const abs = path.join(RENDERER_DIR, rel);
    let out = '';
    try {
      out = execFileSync('grep', ['-noE', '(bg|border|ring)-white/(\\[0\\.[0-9]+\\]|[0-9]+\\b)', abs], {
        encoding: 'utf-8',
      });
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 1) continue; // 零命中
      throw new Error(`表面色收敛门自身故障（grep exit ${e.status}，文件 ${rel}）：${String(err)}`);
    }
    const n = out.trim().split('\n').filter(Boolean).length;
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

describe('表面色 token 收敛棘轮（chat 域+TitleBar 清扫清单，只增不减白名单）', () => {
  it('清单内文件都仍存在（防清单腐烂：文件改名/删除需同步清单）', () => {
    for (const rel of SCOPED_FILES) {
      expect(fs.existsSync(path.join(RENDERER_DIR, rel)), `${rel} 不存在（改名/删除需同步清单）`).toBe(true);
    }
  });

  it('白名单文件都仍存在对应数量的残留（防清单腐烂假绿）', () => {
    const counts = grepWhiteAlphaSites();
    for (const [file, max] of Object.entries(ALLOWLIST)) {
      expect(counts.get(file) ?? 0, `${file} 应恰有 ${max} 处残留（改动/映射需同步白名单）`).toBe(max);
    }
  });

  it('白名单之外零手搓 white-alpha——一律用 surface-*/border-* token', () => {
    const counts = grepWhiteAlphaSites();
    const offenders = [...counts.entries()]
      .filter(([file, n]) => (ALLOWLIST[file] ?? 0) < n)
      .map(([file, n]) => `${file}: ${n} 处（允许 ${ALLOWLIST[file] ?? 0}）`);
    expect(offenders, `发现手搓 white-alpha，请改用 surface-*/border-* token：\n${offenders.join('\n')}`).toEqual([]);
  });
});
