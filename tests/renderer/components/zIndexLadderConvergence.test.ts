// ============================================================================
// z-index 阶梯收敛棘轮：Toast/SessionContextMenu/VoicePasteIndicator/
// MemoFloater/UndoToast/SidebarProjectDrawer 六个全屏浮层已收口进
// src/renderer/styles/zLayers.ts 的 Z_LAYERS，禁止再散落 Tailwind 任意值
// `z-[数字]` class。层级本身走 style={{ zIndex }}（Modal.tsx 早年已验证的
// 套路），不走 Tailwind JIT 静态扫描——JIT 扫不到运行时拼出来的类名。
// 清单只覆盖本批收口过的文件，不扫全仓（组件内部局部层级 z-10/20/30/40/50
// 不归这道门管，那是另一类问题）。同套路照抄 emojiIconConvergence.test.ts。
//
// 「残留 z-[数字] 计数=0」不在这里重复断言——scripts/check-design-system.mjs
// 的 bare-z-index 规则 + design-system-zindex-allowlist.json 双向核对已经
// 全仓覆盖这条不变量（且比这里的正则更全，还管 CSS 文件），本文件只管两件
// 它盖不住的事：阶梯序有没有倒挂、六文件是不是真的接了 Z_LAYERS。
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Z_LAYERS } from '../../../src/renderer/styles/zLayers';

const RENDERER_DIR = path.resolve(__dirname, '../../../src/renderer');

/** 本批收口过的文件（相对 src/renderer）——门只管这些，不扫全域 */
const SCOPED_FILES = [
  'components/Toast.tsx',
  'components/features/sidebar/SessionContextMenu.tsx',
  'components/features/voice/VoicePasteIndicator.tsx',
  'components/features/memo/MemoFloater.tsx',
  'components/primitives/UndoToast.tsx',
  'components/features/sidebar/SidebarProjectDrawer.tsx',
];

describe('z-index 阶梯收敛棘轮（全屏浮层六文件清单，只增不减）', () => {
  it('清单内文件都仍存在（防清单腐烂：文件改名/删除需同步清单）', () => {
    for (const rel of SCOPED_FILES) {
      expect(fs.existsSync(path.join(RENDERER_DIR, rel)), `${rel} 不存在（改名/删除需同步清单）`).toBe(true);
    }
  });

  it('六文件都接入了 Z_LAYERS（防换回硬编码数字 style={{ zIndex: 9999 }}）', () => {
    for (const rel of SCOPED_FILES) {
      const content = fs.readFileSync(path.join(RENDERER_DIR, rel), 'utf-8');
      expect(content, `${rel} 未引用 Z_LAYERS`).toMatch(/Z_LAYERS/);
    }
  });

  it('互压关系与改动前一致：memoFloater < drawer/undoToast < contextMenu/toast/voiceStatus', () => {
    // 现状（改动前）：Toast/SessionContextMenu/VoicePasteIndicator = z-[9999]，
    // SidebarProjectDrawer/UndoToast = z-[9998]，MemoFloater = z-[100]。
    // 阶梯化只重排数值留档间距，不改这三档的相对顺序。
    expect(Z_LAYERS.memoFloater).toBeLessThan(Z_LAYERS.drawer);
    expect(Z_LAYERS.memoFloater).toBeLessThan(Z_LAYERS.undoToast);
    expect(Z_LAYERS.drawer).toBeLessThan(Z_LAYERS.contextMenu);
    expect(Z_LAYERS.drawer).toBeLessThan(Z_LAYERS.toast);
    expect(Z_LAYERS.drawer).toBeLessThan(Z_LAYERS.voiceStatus);
    expect(Z_LAYERS.undoToast).toBeLessThan(Z_LAYERS.contextMenu);
    expect(Z_LAYERS.undoToast).toBeLessThan(Z_LAYERS.toast);
    expect(Z_LAYERS.undoToast).toBeLessThan(Z_LAYERS.voiceStatus);
    // 现状里 drawer 与 undoToast 同档、contextMenu/toast/voiceStatus 同档——
    // 没有证据这是刻意设计（更像历史随手写），保留原相对关系，不新增分档。
    expect(Z_LAYERS.drawer).toBe(Z_LAYERS.undoToast);
    expect(Z_LAYERS.contextMenu).toBe(Z_LAYERS.toast);
    expect(Z_LAYERS.toast).toBe(Z_LAYERS.voiceStatus);
  });
});
