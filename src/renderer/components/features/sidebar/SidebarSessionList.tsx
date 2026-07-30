// ============================================================================
// SidebarSessionList —— 侧栏会话列表区（加载态 / 空态 / 搜索空态 + 分组渲染）。
// 从 `Sidebar` 巨型组件抽出（god-file 红线治理，批P 第三波前置拆分）：
// props 全量透传现有 state/回调，行为零变化；三分区逻辑后续只加在本组件，不回填主文件。
// ============================================================================

import React from 'react';
import { Loader2, MessageSquare, Search } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import type { SessionStatusFilter } from '../../../stores/sessionUIStore';
import { SidebarProjectGroup, type SidebarProjectGroupProps } from './SidebarProjectGroup';
import type { SidebarDerivedSessions } from './useSidebarDerivedSessions';

export interface SidebarSessionListProps extends Omit<SidebarProjectGroupProps, 'group'> {
  groups: SidebarDerivedSessions['workspaceGroupedSessions'];
  isLoading: boolean;
  hasAnySessions: boolean;
  filteredSessionsEmpty: boolean;
  messageSearchLoading: boolean;
  searchQuery: string;
  sessionStatusFilter: SessionStatusFilter;
  activeStatusFilterLabel: string;
}

export const SidebarSessionList: React.FC<SidebarSessionListProps> = ({
  groups,
  isLoading,
  hasAnySessions,
  filteredSessionsEmpty,
  messageSearchLoading,
  searchQuery,
  sessionStatusFilter,
  activeStatusFilterLabel,
  hasSearchFilters,
  projectMetaById,
  setProjectMetaById,
  expandedWorkspaces,
  collapsingWorkspaces,
  expandedProjectDetails,
  projectDrawerKey,
  isCreatingSession,
  creatingWorkspaceKey,
  setProjectDrawerKey,
  setExpandedProjectDetails,
  handleToggleWorkspaceGroup,
  handleOpenWorkspaceAssets,
  handleNewWorkspaceChat,
  handleOpenProjectArtifactSession,
  handleStartProjectGoal,
  handleSelectSession,
  handleRenameSidebarProject,
  handleSetSidebarProjectStatus,
  handleSetSidebarProjectDescription,
  createWorkspaceChat,
  openWorkspacePreview,
  buildProjectDrawerSessions,
  sessionItemProps,
}) => {
  const { t } = useI18n();
  const sb = t.sidebar;
  return (
    /* Session List - Project Grouped
       scrollbar-hidden 不是审美选择，是右轨对齐的根因修复（2026-07-27 实测）：
       global.css 给了 `::-webkit-scrollbar{width:6px}` 这种**占布局宽度**的经典滚动条，
       列表一溢出，容器内容盒就窄 6px ⇒ 组角标/状态点中心被推到 205.8，
       而账号行在滚动容器**外**、中心仍是 212，三者于是不同轴（产品负责人 07-27 反馈）。
       按状态补 6px padding 只在"正在溢出"时对，不溢出时反而错——只有把这段占位彻底去掉，
       栏内所有行才共用同一条右轨（220 右缘 / 212 中心），与溢出与否无关。
       做法（参照 Codex：滚动条独占最右一条窄带，内容轨不受它影响）：侧栏根 `pr` 让出
       一条滚动条宽的窄带 ⇒ 顶行/能力区/账号行都缩到同一条内轨；本滚动容器再用等宽负 margin
       把那条窄带"要回来"，`overflow-y-scroll` 恒定占位把滚动条正好摆进去 ⇒ 它的内容盒宽度
       回到与兄弟块相同的内轨。滚动条照常可见，且与列表溢不溢出无关。 */
    <div className="flex-1 overflow-y-scroll px-1 min-h-0 mr-[calc(var(--scrollbar-size)*-1)]" data-testid="sidebar-session-scroll">
      {isLoading && !hasAnySessions ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-primary-400" />
          <span className="text-xs text-zinc-500">{sb.loading}</span>
        </div>
      ) : !hasAnySessions ? (
        <div className="flex flex-col items-center justify-center h-full text-center px-4">
          <div className="w-12 h-12 rounded-2xl bg-zinc-800 flex items-center justify-center mb-3">
            <MessageSquare className="w-6 h-6 text-zinc-500" />
          </div>
          <p className="text-sm text-zinc-400 mb-1">{sb.noSessions}</p>
          <p className="text-xs text-zinc-500">{sb.startNewTask}</p>
        </div>
      ) : filteredSessionsEmpty && hasSearchFilters ? (
        <div className="flex flex-col items-center justify-center py-12 text-center px-4">
          <Search className="w-6 h-6 text-zinc-600 mb-2" />
          <p className="text-sm text-zinc-500">
            {messageSearchLoading
              ? sb.searchingMessageContent
              : !searchQuery && sessionStatusFilter !== 'all'
                ? sb.noStatusSessions.replace('{label}', activeStatusFilterLabel)
                : sb.noMatchedSessions}
          </p>
        </div>
      ) : (
        /* Workspace/project grouped view, including search and status-filtered results. */
        <div className="py-2">
          {groups.map((group) => (
            <SidebarProjectGroup
              key={group.key}
              group={group}
              projectMetaById={projectMetaById}
              setProjectMetaById={setProjectMetaById}
              hasSearchFilters={hasSearchFilters}
              expandedWorkspaces={expandedWorkspaces}
              collapsingWorkspaces={collapsingWorkspaces}
              expandedProjectDetails={expandedProjectDetails}
              projectDrawerKey={projectDrawerKey}
              isCreatingSession={isCreatingSession}
              creatingWorkspaceKey={creatingWorkspaceKey}
              setProjectDrawerKey={setProjectDrawerKey}
              setExpandedProjectDetails={setExpandedProjectDetails}
              handleToggleWorkspaceGroup={handleToggleWorkspaceGroup}
              handleOpenWorkspaceAssets={handleOpenWorkspaceAssets}
              handleNewWorkspaceChat={handleNewWorkspaceChat}
              handleOpenProjectArtifactSession={handleOpenProjectArtifactSession}
              handleStartProjectGoal={handleStartProjectGoal}
              handleSelectSession={handleSelectSession}
              handleRenameSidebarProject={handleRenameSidebarProject}
              handleSetSidebarProjectStatus={handleSetSidebarProjectStatus}
              handleSetSidebarProjectDescription={handleSetSidebarProjectDescription}
              createWorkspaceChat={createWorkspaceChat}
              openWorkspacePreview={openWorkspacePreview}
              buildProjectDrawerSessions={buildProjectDrawerSessions}
              sessionItemProps={sessionItemProps}
            />
          ))}
        </div>
      )}
    </div>
  );
};
