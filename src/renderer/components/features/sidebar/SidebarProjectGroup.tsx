import React, { useState, type Dispatch, type SetStateAction } from 'react';
import {
  ChevronRight,
  Folder,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  Plus,
} from 'lucide-react';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import {
  buildSidebarProjectSummary,
  formatSidebarProjectSummaryLine,
} from '../../../utils/sidebarProjectSummary';
import { isWorkspaceExpanded } from '../../../utils/workspaceGrouping';
import { resolveSidebarGroupExpansionView } from '../../../utils/sidebarGroupExpansion';
import { SidebarProjectDetail } from './SidebarProjectDetail';
import { SidebarProjectDrawer, type SidebarProjectDrawerSession } from './SidebarProjectDrawer';
import { SidebarSessionItem, type SidebarSessionItemSharedProps } from './SidebarSessionItem';
import { SessionContextMenu } from './SessionContextMenu';
import type { SidebarDerivedSessions } from './useSidebarDerivedSessions';
import type { SidebarSessionActions } from './useSidebarSessionActions';

export interface SidebarProjectGroupProps {
  group: SidebarDerivedSessions['workspaceGroupedSessions'][number];
  projectMetaById: SidebarDerivedSessions['projectMetaById'];
  hasSearchFilters: boolean;
  expandedWorkspaces: Parameters<typeof isWorkspaceExpanded>[0];
  collapsingWorkspaces: Record<string, boolean>;
  expandedProjectDetails: Record<string, boolean>;
  projectDrawerKey: string | null;
  isCreatingSession: boolean;
  creatingWorkspaceKey: string | null;
  setProjectDrawerKey: Dispatch<SetStateAction<string | null>>;
  setExpandedProjectDetails: Dispatch<SetStateAction<Record<string, boolean>>>;
  handleToggleWorkspaceGroup: SidebarSessionActions['handleToggleWorkspaceGroup'];
  handleNewWorkspaceChat: SidebarSessionActions['handleNewWorkspaceChat'];
  handleOpenProjectArtifactSession: SidebarSessionActions['handleOpenProjectArtifactSession'];
  handleStartProjectGoal: SidebarSessionActions['handleStartProjectGoal'];
  handleSelectSession: SidebarSessionActions['handleSelectSession'];
  handleRenameSidebarProject: SidebarSessionActions['handleRenameSidebarProject'];
  handleSetSidebarProjectStatus: SidebarSessionActions['handleSetSidebarProjectStatus'];
  handleSetSidebarProjectDescription: SidebarSessionActions['handleSetSidebarProjectDescription'];
  createWorkspaceChat: SidebarSessionActions['createWorkspaceChat'];
  openWorkspacePreview: (previewItemId?: string | null) => void;
  buildProjectDrawerSessions: (groupSessions: SessionWithMeta[]) => SidebarProjectDrawerSession[];
  sessionItemProps: SidebarSessionItemSharedProps;
}

/**
 * 单个工作区/项目分组：分组头（折叠/控制台/详情/产物/新建按钮）+ 项目详情 + 项目抽屉 +
 * 展开后的会话行列表。从 `Sidebar` 巨型组件的 workspaceGroupedSessions.map body 抽出。
 * 会话行共享 props 经 sessionItemProps 单对象透传，零行为改动。
 */
export const SidebarProjectGroup: React.FC<SidebarProjectGroupProps> = ({
  group,
  projectMetaById,
  hasSearchFilters,
  expandedWorkspaces,
  collapsingWorkspaces,
  expandedProjectDetails,
  projectDrawerKey,
  isCreatingSession,
  creatingWorkspaceKey,
  setProjectDrawerKey,
  setExpandedProjectDetails,
  handleToggleWorkspaceGroup,
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
  const {
    backgroundTaskMap,
    sessionRuntimes,
    sessionStates,
    hasPendingApprovalForSession,
    reviewItemsBySessionId,
    currentSessionId,
  } = sessionItemProps;

  const [moreMenuPos, setMoreMenuPos] = useState<{ x: number; y: number } | null>(null);
  const IconComponent = group.isUncategorized ? MessageSquareText : Folder;
  const projectMeta = group.projectId ? projectMetaById[group.projectId] : undefined;
  const summary = buildSidebarProjectSummary({
    group,
    backgroundTaskMap,
    sessionRuntimes,
    sessionStates,
    hasPendingApprovalForSession,
    reviewItemsBySessionId,
    projectMeta: hasSearchFilters && projectMeta
      ? { ...projectMeta, sessionCount: group.sessions.length }
      : projectMeta,
  });
  const groupHasCurrentSession = group.sessions.some((session) => session.id === currentSessionId);
  const groupExpansionSignals = {
    hasCurrentSession: groupHasCurrentSession,
    hasSearchFilters,
    unfinishedCount: summary.unfinishedCount,
  };
  const expansionView = resolveSidebarGroupExpansionView({
    persistedExpanded: isWorkspaceExpanded(expandedWorkspaces, group.key),
    signals: groupExpansionSignals,
    isCollapsing: Boolean(collapsingWorkspaces[group.key]),
    displayName: summary.displayName,
    disableForceExpand: group.isUncategorized,
  });
  const expanded = expansionView.isVisibleExpanded;
  const summaryLine = formatSidebarProjectSummaryLine({
    summary,
    isUncategorized: group.isUncategorized,
    isFiltered: hasSearchFilters,
    workspacePaths: group.paths,
  });
  const title = group.isUncategorized
    ? '纯对话，不继承项目上下文'
    : `${summary.displayName}${group.paths.length > 0 ? ` · ${group.paths.join(' · ')}` : ''}`;
  const detailsExpanded = Boolean(expandedProjectDetails[group.key]);
  const drawerOpen = projectDrawerKey === group.key;
  const drawerSessions = drawerOpen ? buildProjectDrawerSessions(group.sessions as SessionWithMeta[]) : [];
  return (
    <div
      className="mb-2"
      data-sidebar-group-phase={expansionView.phase}
    >
      <div
        className="group sticky top-0 z-20 flex items-center gap-1.5 w-full px-3 py-1.5 bg-zinc-900 backdrop-blur-sm text-left hover:bg-zinc-800/40 transition-colors"
        title={title}
      >
        <button
          type="button"
          title={expansionView.toggleTitle}
          aria-label={expansionView.toggleAriaLabel}
          aria-disabled={expansionView.forceExpanded ? 'true' : undefined}
          onClick={() => handleToggleWorkspaceGroup(group.key, expansionView)}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
        >
          <ChevronRight
            className={`mt-0.5 w-3 h-3 text-zinc-500 transition-transform ${
              expanded ? 'rotate-90' : ''
            } ${expansionView.phase === 'collapsing' ? 'opacity-70' : ''}`}
          />
          <IconComponent className="mt-0.5 w-3 h-3 text-zinc-500" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-medium text-zinc-400">{summary.displayName}</span>
              {expansionView.protectionLabel && (
                <span className="shrink-0 rounded-full border border-zinc-700 bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                  {expansionView.protectionLabel}
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-zinc-600">
              {summaryLine}
            </span>
          </span>
        </button>
        {!group.isUncategorized && (
          <button
            type="button"
            aria-label={`${summary.displayName} 更多操作`}
            title="更多操作"
            aria-haspopup="menu"
            aria-expanded={moreMenuPos ? 'true' : 'false'}
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMoreMenuPos({ x: rect.right, y: rect.bottom + 4 });
            }}
            className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        )}
        {!group.isUncategorized && (
          <button
            type="button"
            aria-label={`在 ${summary.displayName} 新建会话`}
            title={`在 ${summary.displayName} 新建会话`}
            onClick={(e) => handleNewWorkspaceChat(e, group.key, group.path)}
            disabled={isCreatingSession || (creatingWorkspaceKey !== null && creatingWorkspaceKey !== group.key)}
            className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden disabled:opacity-50"
          >
            {creatingWorkspaceKey === group.key ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        {(() => {
          // 工作区数字徽章(最右、圆形):仅当有 执行中/出错/待确认 时显示;数字=三类总数;
          // 颜色优先级 出错红 > 待确认蓝 > 纯执行中中性。全是已完成/历史则不显示。
          const activeTotal = summary.runningCount + summary.errorCount + summary.pendingApprovalCount;
          if (activeTotal === 0) return null;
          const tone = summary.errorCount > 0
            ? 'border-red-500/30 bg-red-500/15 text-red-300'
            : summary.pendingApprovalCount > 0
              ? 'border-blue-500/30 bg-blue-500/15 text-blue-300'
              : 'border-zinc-600/50 bg-zinc-700/50 text-zinc-300';
          const badgeTitle = [
            summary.runningCount > 0 ? `${summary.runningCount} 执行中` : null,
            summary.errorCount > 0 ? `${summary.errorCount} 出错` : null,
            summary.pendingApprovalCount > 0 ? `${summary.pendingApprovalCount} 待确认` : null,
          ].filter(Boolean).join(' · ');
          return (
            <span
              title={badgeTitle}
              className={`ml-1 inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full border px-1 text-[10px] font-semibold leading-none tabular-nums ${tone}`}
            >
              {activeTotal}
            </span>
          );
        })()}
      </div>
      {moreMenuPos && !group.isUncategorized && (
        <SessionContextMenu
          x={moreMenuPos.x}
          y={moreMenuPos.y}
          onClose={() => setMoreMenuPos(null)}
          items={[
            {
              label: '项目控制台',
              icon: '🖥',
              onClick: () => setProjectDrawerKey(group.key),
            },
            {
              label: detailsExpanded ? '收起项目详情' : '项目详情',
              icon: '📋',
              onClick: () => setExpandedProjectDetails((previous) => ({
                ...previous,
                [group.key]: !previous[group.key],
              })),
            },
            {
              label: '产物与资产',
              icon: '📦',
              onClick: () => openWorkspacePreview(),
            },
          ]}
        />
      )}
      {detailsExpanded && !group.isUncategorized && (
        <SidebarProjectDetail
          meta={projectMeta}
          fallbackSessionCount={group.sessions.length}
          onOpenArtifactSession={handleOpenProjectArtifactSession}
          onStartGoal={(goal) => { void handleStartProjectGoal(goal, group.key, group.path); }}
        />
      )}
      {drawerOpen && !group.isUncategorized && (
        <SidebarProjectDrawer
          title={summary.displayName}
          summaryLine={summaryLine}
          paths={group.paths}
          meta={projectMeta}
          summary={summary}
          sessions={drawerSessions}
          filtered={hasSearchFilters}
          onClose={() => setProjectDrawerKey(null)}
          onOpenSession={async (sessionId) => {
            await handleSelectSession(sessionId);
            setProjectDrawerKey(null);
          }}
          onOpenArtifactSession={async (artifact) => {
            await handleOpenProjectArtifactSession(artifact);
            setProjectDrawerKey(null);
          }}
          onStartGoal={async (goal) => {
            await handleStartProjectGoal(goal, group.key, group.path);
            setProjectDrawerKey(null);
          }}
          onOpenGoalSession={async (sessionId) => {
            await handleSelectSession(sessionId);
            setProjectDrawerKey(null);
          }}
          onOpenWorkspaceAssets={() => {
            openWorkspacePreview();
            setProjectDrawerKey(null);
          }}
          onNewSession={async () => {
            await createWorkspaceChat(group.key, group.path);
            setProjectDrawerKey(null);
          }}
          onRenameProject={group.projectId
            ? async (name) => { await handleRenameSidebarProject(group.projectId!, name); }
            : undefined}
          onSetProjectDescription={group.projectId
            ? async (description) => { await handleSetSidebarProjectDescription(group.projectId!, description); }
            : undefined}
          onSetProjectStatus={group.projectId
            ? async (status) => { await handleSetSidebarProjectStatus(group.projectId!, status); }
            : undefined}
        />
      )}
      {expanded && (
        <div
          className={expansionView.rowsClassName}
          data-sidebar-group-rows={group.key}
        >
          {group.sessions.length === 0 ? (
            <div className="px-3 py-1 text-xs text-zinc-600">No chats</div>
          ) : (
            group.sessions.map((session, index) => (
              <div
                key={session.id}
                className="sidebar-project-row"
                style={{
                  '--sidebar-row-delay': `${Math.min(index * 24, 160)}ms`,
                } as React.CSSProperties}
              >
                <SidebarSessionItem
                  session={session as SessionWithMeta}
                  {...sessionItemProps}
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
