// ============================================================================
// TitleBar - 右侧顶栏
// （目录 chip 已退役：目录选择收进侧栏「项目」区的新建项目流程与项目行 ⋯ 菜单。）
//
// 2026-07-27 审美关拍板：侧栏收起开关挪回左侧面板自己头上（SidebarHeader），
// 这里只在**侧栏收起态**留展开入口——侧栏那时不存在，按钮得有别的落脚点。
// 于是「二级页在位 + 侧栏展开」时本栏三个槽位全空，由 App 直接不渲染它，
// 让二级页大标题贴到窗口顶（Codex 式）。判定与 App 的 shouldRenderTitleBar 同源。
// ============================================================================
import React from 'react';
import { useAppStore } from '../stores/appStore';
import { PanelLeft, PanelRight, PanelRightClose } from 'lucide-react';
import { IconButton } from './primitives';
import { SessionActionsMenu } from './SessionActionsMenu';
import { COLLAPSED_TRAFFIC_LIGHT_INSET } from './features/shared/trafficLightInset';
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
    // 本行整体可拖，行内控件逐个 no-drag。拖拽真正生效靠 `data-tauri-drag-region`
    // （WKWebView 不认 Electron 的 -webkit-app-region），双击缩放窗口也由它带来。
    // 无 border-b、无自有底色：与右栏内容是同一块面（2026-07-27 左右结构拍板）。
    // 底色由 App 的右栏容器统一给（main 的 #760 把 bg-zinc-900 写在本行，合并时收敛到 App 一处，
    // 免得两个地方各给一次底色）。画一条横线会把右栏切成上下两段，正是要消除的读法。
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
      {/* Right: 右栏开关。**两态同住一个位置**——2026-07-27 产品负责人：「展开收起侧边栏按钮
          为什么纵向位置会变？」根因是收起态的入口在本栏（h-12，中心 24）、展开态的收起钮在
          面板头那一行，同一个开关的两态住在两行里，一开一收就跳。改回顶栏单点：图标随状态翻，
          位置恒定。（这推翻了 2026-07-26 打磨批 D5 的「顶栏不叠一颗」——D5 去的是重复，
          代价是位移；位移比重复更伤，且现在顶栏这颗是唯一一颗，不构成重复。） */}
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {!secondaryPageActive && (
          <IconButton
            icon={workbenchCollapsed ? <PanelRight className="w-4 h-4" /> : <PanelRightClose className="w-4 h-4" />}
            aria-label={workbenchCollapsed ? t.workbenchTabs.expandPanel : t.workbenchTabs.collapsePanel}
            data-testid={workbenchCollapsed ? 'titlebar-expand-workbench' : 'titlebar-collapse-workbench'}
            onClick={() => setWorkbenchCollapsed(!workbenchCollapsed)}
            variant="ghost"
            size="md"
          />
        )}
      </div>
    </div>
  );
};
