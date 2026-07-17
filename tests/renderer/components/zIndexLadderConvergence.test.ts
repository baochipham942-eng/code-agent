// ============================================================================
// z-index 阶梯收敛棘轮：Toast/SessionContextMenu/VoicePasteIndicator/
// MemoFloater/UndoToast/SidebarProjectDrawer 六个全屏浮层 + 批 C 收编的
// primitives/Modal（含 ForceUpdateModal/DevServerLauncher 覆盖档）/
// SessionReplaySummaryDialog/AgentSwitcher/ModelSwitcher 五个文件，已全部
// 收口进 src/renderer/styles/zLayers.ts 的 Z_LAYERS，禁止再散落 Tailwind
// 任意值 `z-[数字]` class。层级本身走 style={{ zIndex }}（Modal.tsx 早年已
// 验证的套路），不走 Tailwind JIT 静态扫描——JIT 扫不到运行时拼出来的类名。
// 清单只覆盖本批收口过的文件，不扫全仓（组件内部局部层级 z-10/20/30/40/50
// 不归这道门管，那是另一类问题）。同套路照抄 emojiIconConvergence.test.ts。
//
// 「残留 z-[数字] 计数=0」不在这里重复断言——scripts/check-design-system.mjs
// 的 bare-z-index 规则 + design-system-zindex-allowlist.json 双向核对已经
// 全仓覆盖这条不变量（且比这里的正则更全，还管 CSS 文件），本文件只管两件
// 它盖不住的事：阶梯序有没有倒挂、清单内文件是不是真的接了 Z_LAYERS。
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
  'components/primitives/Modal.tsx',
  'components/ForceUpdateModal.tsx',
  'components/LivePreview/DevServerLauncher.tsx',
  'components/features/sidebar/SessionReplaySummaryDialog.tsx',
  'components/StatusBar/AgentSwitcher.tsx',
  'components/StatusBar/ModelSwitcher.tsx',
];

describe('z-index 阶梯收敛棘轮（全屏浮层清单，只增不减）', () => {
  it('清单内文件都仍存在（防清单腐烂：文件改名/删除需同步清单）', () => {
    for (const rel of SCOPED_FILES) {
      expect(fs.existsSync(path.join(RENDERER_DIR, rel)), `${rel} 不存在（改名/删除需同步清单）`).toBe(true);
    }
  });

  it('清单内文件都接入了 Z_LAYERS（防换回硬编码数字 style={{ zIndex: 9999 }}）', () => {
    for (const rel of SCOPED_FILES) {
      const content = fs.readFileSync(path.join(RENDERER_DIR, rel), 'utf-8');
      expect(content, `${rel} 未引用 Z_LAYERS`).toMatch(/Z_LAYERS/);
    }
  });

  it('清单内文件不含数字 zIndex 字面量（钉调用点：光有 import 不算数，两种形态都要抓）', () => {
    // 只 grep /Z_LAYERS/ 会被"换回字面量但保留 import"的改动骗过（假绿）。
    // style 对象形态 `zIndex: 数字` 和 JSX prop 形态 `zIndex={数字}` 分开匹配，
    // 都不命中 `zIndex: Z_LAYERS.xxx` / `zIndex={Z_LAYERS.xxx}`（冒号/花括号后接的
    // 不是数字）。
    const BARE_NUMERIC_ZINDEX_RE = /zIndex:\s*\d|zIndex=\{\s*\d/;
    for (const rel of SCOPED_FILES) {
      const content = fs.readFileSync(path.join(RENDERER_DIR, rel), 'utf-8');
      expect(content, `${rel} 残留数字 zIndex 字面量（style 对象或 JSX prop 形态）`).not.toMatch(
        BARE_NUMERIC_ZINDEX_RE
      );
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

  it('批 C 收编档序与改动前一致：modal < devServerModal < forceUpdateModal < memoFloater，statusPopover 与 toast 同档，criticalOverlay 压过全部其他档', () => {
    // 现状（改动前）：primitives/Modal.tsx 默认 zIndex=50，DevServerLauncher
    // zIndex=80，ForceUpdateModal zIndex=100——三者都远低于旧 MemoFloater
    // z-[100]（注：旧 ForceUpdateModal 与旧 MemoFloater 数值恰好都是 100，
    // 是历史巧合撞车，不是刻意设计的相等关系，阶梯化后自然消解）。
    // AgentSwitcher/ModelSwitcher 原 zIndex=9999，与旧 Toast 同值；
    // SessionReplaySummaryDialog 原 zIndex=10000，刻意压过旧 Toast 的 9999。
    expect(Z_LAYERS.modal).toBeLessThan(Z_LAYERS.devServerModal);
    expect(Z_LAYERS.devServerModal).toBeLessThan(Z_LAYERS.forceUpdateModal);
    expect(Z_LAYERS.forceUpdateModal).toBeLessThan(Z_LAYERS.memoFloater);

    expect(Z_LAYERS.statusPopover).toBe(Z_LAYERS.toast);

    expect(Z_LAYERS.criticalOverlay).toBeGreaterThan(Z_LAYERS.memoFloater);
    expect(Z_LAYERS.criticalOverlay).toBeGreaterThan(Z_LAYERS.drawer);
    expect(Z_LAYERS.criticalOverlay).toBeGreaterThan(Z_LAYERS.undoToast);
    expect(Z_LAYERS.criticalOverlay).toBeGreaterThan(Z_LAYERS.contextMenu);
    expect(Z_LAYERS.criticalOverlay).toBeGreaterThan(Z_LAYERS.toast);
    expect(Z_LAYERS.criticalOverlay).toBeGreaterThan(Z_LAYERS.voiceStatus);
    expect(Z_LAYERS.criticalOverlay).toBeGreaterThan(Z_LAYERS.statusPopover);
  });
});
