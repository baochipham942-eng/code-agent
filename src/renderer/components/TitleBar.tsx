// ============================================================================
// TitleBar - 右侧顶栏
// （目录 chip 已退役：目录选择并入新任务流程，入口在欢迎页目录 chip / DirectoryPickerModal。）
//
// 2026-07-27 审美关拍板：侧栏收起开关挪回左侧面板自己头上（SidebarHeader），
// 这里只在**侧栏收起态**留展开入口——侧栏那时不存在，按钮得有别的落脚点。
// 于是「二级页在位 + 侧栏展开」时本栏三个槽位全空，由 App 直接不渲染它，
// 让二级页大标题贴到窗口顶（Codex 式）。判定与 App 的 shouldRenderTitleBar 同源。
// ============================================================================
import React from 'react';
import { useAppStore } from '../stores/appStore';
import { PanelLeft, PanelRight } from 'lucide-react';
import { IconButton } from './primitives';
import { SessionActionsMenu } from './SessionActionsMenu';
import { useI18n } from '../hooks/useI18n';

interface TitleBarProps {
  /** 二级页（能力中心/资料库/自动化等）在位：会话动作与右栏开关都无对象 */
  secondaryPageActive?: boolean;
}

export const TitleBar: React.FC<TitleBarProps> = ({ secondaryPageActive = false }) => {
  const { t } = useI18n();
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    workbenchCollapsed,
    setWorkbenchCollapsed,
  } = useAppStore();
  return (
    // 原生标题栏已撤（tauri.conf.json titleBarStyle=Overlay），窗口得自己留拖拽区：
    // 本行整体可拖，行内控件逐个 no-drag。
    // bg-zinc-900 与下方聊天区/右栏同色、不画下边框——顶栏与内容区打通成一整块
    // （2026-07-27 产品负责人：黑色顶栏与下方割裂）。
    <div
      className="h-12 flex items-center justify-between px-4 bg-zinc-900 relative z-30"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {sidebarCollapsed && (
          <IconButton
            icon={<PanelLeft className="w-4 h-4" />}
            aria-label={t.sidebar.expandSidebar}
            data-testid="titlebar-expand-sidebar"
            onClick={() => setSidebarCollapsed(false)}
            variant="ghost"
            size="md"
          />
        )}
        {!secondaryPageActive && <SessionActionsMenu />}
      </div>
      {/* Right: 右栏收起态的展开入口。展开态的收起 affordance 在面板头
          （WorkbenchTabs 收起按钮），顶栏不再叠一颗（2026-07-26 打磨批 D D5 去重）。 */}
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {workbenchCollapsed && !secondaryPageActive && (
          <IconButton
            icon={<PanelRight className="w-4 h-4" />}
            aria-label={t.workbenchTabs.expandPanel}
            data-testid="titlebar-expand-workbench"
            onClick={() => setWorkbenchCollapsed(false)}
            variant="ghost"
            size="md"
          />
        )}
      </div>
    </div>
  );
};
