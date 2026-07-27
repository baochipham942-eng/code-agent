// ============================================================================
// TitleBar - 右侧顶栏
// （目录 chip 已退役：工作目录选择并入侧栏项目组体系，入口在 SidebarWorkspaceRow。）
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
import { getCurrentKeybindingPlatform } from '@shared/keybindings/defaults';
import { useI18n } from '../hooks/useI18n';

// 侧栏展开时红绿灯浮在**侧栏**顶行上，本栏不受影响；侧栏一收起，本栏就成了窗口左上角那块，
// 灯直接压在展开按钮上（2026-07-27 产品负责人截图）。darwin 下这一档要让开灯区：
// 灯占 x9-68（objc 摆过纵向，横向仍是系统默认），再留一点呼吸位 ⇒ 84。
const COLLAPSED_TRAFFIC_LIGHT_INSET = getCurrentKeybindingPlatform() === 'darwin' ? 'pl-[84px]' : '';

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
    // 本行整体可拖，行内控件逐个 no-drag。拖拽真正生效靠 `data-tauri-drag-region`
    // （WKWebView 不认 Electron 的 -webkit-app-region），双击缩放窗口也由它带来。
    // 无 border-b、无自有底色：与右栏内容是同一块面（2026-07-27 左右结构拍板）。
    // 画一条横线会把右栏切成上下两段，正是要消除的读法；底色由 App 的右栏容器统一给。
    <div
      data-tauri-drag-region
      className={`h-12 flex items-center justify-between px-4 bg-transparent relative z-30 ${sidebarCollapsed ? COLLAPSED_TRAFFIC_LIGHT_INSET : ''}`}
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
