// ============================================================================
// TitleBar - Right side title bar with sidebar / session / workbench toggles
// （目录 chip 已退役：工作目录选择并入侧栏项目组体系，入口在 SidebarWorkspaceRow，
//   腾出的居中视觉空间不再补东西。）
// ============================================================================
import React from 'react';
import { useAppStore } from '../stores/appStore';
import { PanelLeftClose, PanelLeft, PanelRightClose, PanelRight } from 'lucide-react';
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
      {/* Right: 整个右栏的收起/展开。它管的是栏，不是「概览」这一个面板。 */}
      <div className="flex items-center gap-2">
        <IconButton
          icon={workbenchCollapsed ? <PanelRight className="w-4 h-4" /> : <PanelRightClose className="w-4 h-4" />}
          aria-label={workbenchCollapsed ? t.workbenchTabs.expandPanel : t.workbenchTabs.collapsePanel}
          onClick={() => setWorkbenchCollapsed(!workbenchCollapsed)}
          variant="ghost"
          size="md"
        />
      </div>
    </div>
  );
};
