// ============================================================================
// TitleBar - Right side title bar with sidebar / session / workbench toggles
// （目录 chip 已退役：工作目录选择并入侧栏项目组体系，入口在 SidebarWorkspaceRow，
//   腾出的居中视觉空间不再补东西。）
// ============================================================================
import React from 'react';
import { useAppStore } from '../stores/appStore';
import { PanelLeftClose, PanelLeft, PanelRight } from 'lucide-react';
import { IconButton } from './primitives';
import { SessionActionsMenu } from './SessionActionsMenu';
import { useI18n } from '../hooks/useI18n';
export const TitleBar: React.FC = () => {
  const { t } = useI18n();
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    workbenchCollapsed,
    setWorkbenchCollapsed,
  } = useAppStore();
  return (
    <div className="h-12 flex items-center justify-between px-4 border-b border-border-muted bg-transparent backdrop-blur-sm relative z-30">
      {/* Left: sidebar toggle + session actions */}
      <div className="flex items-center gap-2">
        {/* Sidebar Toggle */}
        <IconButton
          icon={sidebarCollapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          variant="ghost"
          size="md"
        />
        <SessionActionsMenu />
      </div>
      {/* Right: 右栏收起态的展开入口。展开态的收起 affordance 在面板头
          （WorkbenchTabs 收起按钮），顶栏不再叠一颗（2026-07-26 打磨批 D D5 去重）。
          右栏没有全局快捷键（快捷键只覆盖左栏），收起/展开均走这两处按钮。 */}
      <div className="flex items-center gap-2">
        {workbenchCollapsed && (
          <IconButton
            icon={<PanelRight className="w-4 h-4" />}
            aria-label={t.workbenchTabs.expandPanel}
            onClick={() => setWorkbenchCollapsed(false)}
            variant="ghost"
            size="md"
          />
        )}
      </div>
    </div>
  );
};
