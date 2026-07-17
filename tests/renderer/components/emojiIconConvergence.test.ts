// ============================================================================
// emoji→lucide 图标化收敛棘轮：Toast / CitationList / sessionContextMenuItems
// (+消费方 SessionContextMenu) 已清扫完的文件里，禁止再用 emoji 字面量当图标。
// 按 unicode 区间枚举（emoji pictograph + symbol + arrow 区）而不是按具体字符
// 枚举——新增 emoji 形态也会被扫到。清单只覆盖本批清扫过的文件，不扫全仓
// （toolSummary.ts / ToolCallGroup / scheduleTemplates.ts 的用户可选 emoji 字段
// 不归这道门管）。同套路照抄 surfaceTokenConvergence.test.ts（PR #450）。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isValidElement } from 'react';
import {
  buildSessionContextMenuItems,
  type SessionContextMenuDeps,
} from '../../../src/renderer/components/features/sidebar/sessionContextMenuItems';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { zh } from '../../../src/renderer/i18n/zh';

const RENDERER_DIR = path.resolve(__dirname, '../../../src/renderer');

/** 本批清扫过的文件（相对 src/renderer）——门只管这些，不扫全域 */
const SCOPED_FILES = [
  'components/Toast.tsx',
  'components/citations/CitationList.tsx',
  'components/features/sidebar/sessionContextMenuItems.ts',
  'components/features/sidebar/SessionContextMenu.tsx',
];

/** emoji pictograph（1F300-1FAFF）+ misc symbol（2600-27BF）+ arrow（2190-21FF）区间。
 * 用 Node 自带正则直接扫文件内容，不 shell out 给 grep——BSD grep（macOS 系统自带）
 * 不支持 -P/PCRE 的 \x{...} Unicode 转义，会整门报「自身故障」假红。 */
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/gu;

function grepEmojiSites(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rel of SCOPED_FILES) {
    const abs = path.join(RENDERER_DIR, rel);
    const content = fs.readFileSync(abs, 'utf-8');
    const matches = content.match(EMOJI_PATTERN);
    if (matches && matches.length > 0) counts.set(rel, matches.length);
  }
  return counts;
}

describe('emoji→lucide 图标收敛棘轮（Toast/CitationList/sessionContextMenuItems 清单，只增不减）', () => {
  it('清单内文件都仍存在（防清单腐烂：文件改名/删除需同步清单）', () => {
    for (const rel of SCOPED_FILES) {
      expect(fs.existsSync(path.join(RENDERER_DIR, rel)), `${rel} 不存在（改名/删除需同步清单）`).toBe(true);
    }
  });

  it('零残留 emoji 图标——一律用 lucide-react 组件', () => {
    const counts = grepEmojiSites();
    const offenders = [...counts.entries()].map(([file, n]) => `${file}: ${n} 处`);
    expect(offenders, `发现残留 emoji 图标，请改用 lucide-react：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('icon 字段是组件（ReactElement）不是裸字符串——防回退到 emoji 字面量', () => {
    // 真正防回退的是「运行时值不是 string」而不是类型标注本身（类型标注
    // 可以被静默改宽而不报错，运行时值才是硬证据）。抽 buildSessionContextMenuItems
    // 的真实产物验证，而非自己 createElement 一个样本自证。
    const session = { id: 'sess-1', title: 'x', isArchived: false } as SessionWithMeta;
    const deps: SessionContextMenuDeps = {
      pinnedSessionIds: new Set<string>(),
      savedWorkbenchPresets: [],
      savedWorkbenchRecipes: [],
      setWorkingDirectory: vi.fn(),
      applyWorkbenchPreset: vi.fn(),
      applyWorkbenchRecipe: vi.fn(),
      applySessionWorkbenchPreset: vi.fn(),
      saveWorkbenchPresetFromSession: vi.fn(),
      togglePin: vi.fn(),
      setRenamingId: vi.fn(),
      setRenameValue: vi.fn(),
      canOpenSessionReplay: false,
      handleOpenSessionReplay: vi.fn(),
      unarchiveSession: vi.fn(),
      archiveSession: vi.fn(),
      softDelete: vi.fn(),
      saveExportToDownloads: vi.fn(),
      showToast: vi.fn(() => 'toast-id'),
      openRuntimeLogsFolder: vi.fn(async () => true),
      t: zh,
    };
    const items = buildSessionContextMenuItems(session, deps);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(typeof item.icon, `${item.label} 的 icon 不能是裸字符串`).not.toBe('string');
      expect(isValidElement(item.icon), `${item.label} 的 icon 必须是有效 ReactElement`).toBe(true);
    }
  });
});
