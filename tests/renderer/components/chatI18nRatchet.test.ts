// ============================================================================
// Chat 域 i18n 迁移棘轮
// 已迁文件（MIGRATED）源码中禁止再出现中文字面量（注释除外）——防回潮硬闸。
// 迁移一个文件就把它加进 MIGRATED；模式同 settingsContentI18nRatchet.test.ts。
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RENDERER_DIR = path.resolve(__dirname, '../../../src/renderer');
const COMPONENTS_DIR = path.join(RENDERER_DIR, 'components');

/** 已完成 i18n 迁移的文件（相对 components 目录）。只增不减。 */
const MIGRATED: string[] = [
  'ChatView.tsx',
  'CommandPalette.tsx',
  'features/chat/TurnBasedTraceView.tsx',
  'features/chat/ChatSearchBar.tsx',
  'features/chat/ToolStepGroup.tsx',
  'features/chat/MessageBubble/TurnDiffSummary.tsx',
  'features/chat/MessageBubble/ToolCallDisplay/statusLabels.ts',
  'features/chat/ChatInput/index.tsx',
  'features/chat/ChatInput/InputArea.tsx',
  'features/chat/ChatInput/AttachmentBar.tsx',
  'features/chat/ChatInput/SendButton.tsx',
  'features/chat/ChatInput/useFileUpload.ts',
  'features/chat/ChatInput/ScheduleComposerCard.tsx',
  'Sidebar.tsx',
  'features/sidebar/SessionContextMenu.tsx',
  'features/sidebar/SessionReplaySummaryDialog.tsx',
  'features/sidebar/SessionTypeFilterBar.tsx',
  'features/sidebar/SidebarMessageHitList.tsx',
  'features/sidebar/SidebarProjectDetail.tsx',
  'features/sidebar/SidebarProjectDrawer.tsx',
  'features/sidebar/SidebarProjectGroup.tsx',
  'features/sidebar/SidebarSessionItem.tsx',
  'features/sidebar/SidebarStatusFilterDropdown.tsx',
  'features/sidebar/sessionContextMenuItems.ts',
  'features/sidebar/sidebarFilterOptions.ts',
  'features/sidebar/sidebarPresentation.tsx',
  'features/sidebar/useSidebarDerivedSessions.ts',
  'features/sidebar/useSidebarRowActions.ts',
  'features/sidebar/useSidebarSessionActions.ts',
  'PreviewPanel.tsx',
  'WorkspacePreviewPanel.tsx',
  'WorkspaceAssets.tsx',
  'workspacePreview/helpers.ts',
  'workspacePreview/parts.tsx',
  'primitives/Modal.tsx',
  'primitives/UndoToast.tsx',
  'composites/ConfirmDialog.tsx',
  'ErrorBoundary.tsx',
  'citations/CitationList.tsx',
  'PlanningPanel.tsx',
  'RewindPanel.tsx',
  'SkillsPanel.tsx',
  'ContextHealthPanel.tsx',
  'TaskPanel/TaskMonitor.tsx',
  'TaskPanel/Orchestration.tsx',
  'TaskPanel/RunWorkbenchCards.tsx',
  'TaskPanel/ApprovalSyncCard.tsx',
  'UpdateNotification.tsx',
  'ForceUpdateModal.tsx',
  'TokenWarning.tsx',
  'BudgetAlertNotice.tsx',
  'ProviderStatusNotice.tsx',
];

const HAN_RE = /[一-鿿]/;
// 反逃逸：一-鿿 区间的 unicode 转义写法同样算中文字面量（settings 批7实测 '打开' 绕闸）
const HAN_ESCAPE_RE = /\\u(?:4[e-f]|[5-8][0-9a-f]|9[0-9a-f])[0-9a-f]{2}/i;

/** 去掉行注释、块注释、JSX 注释后再扫描，避免中文注释误报 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"\\])\/\/[^'"\n]*$/gm, '$1');
}

describe('Chat 域 i18n 棘轮（已迁文件无中文字面量）', () => {
  it('MIGRATED 清单内的文件都存在', () => {
    for (const rel of MIGRATED) {
      const abs = path.join(COMPONENTS_DIR, rel);
      expect(fs.existsSync(abs), `${rel} 不存在（改名/删除需同步清单）`).toBe(true);
    }
  });

  for (const rel of MIGRATED) {
    it(`已迁文件无中文字面量: ${rel}`, () => {
      const source = fs.readFileSync(path.join(COMPONENTS_DIR, rel), 'utf-8');
      const code = stripComments(source);
      const offending = code
        .split('\n')
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        .filter(({ line }) => HAN_RE.test(line) || HAN_ESCAPE_RE.test(line));
      expect(
        offending.map(({ no, line }) => `L${no}: ${line.slice(0, 80)}`),
        `${rel} 还有 ${offending.length} 处中文字面量`,
      ).toEqual([]);
    });
  }
});
