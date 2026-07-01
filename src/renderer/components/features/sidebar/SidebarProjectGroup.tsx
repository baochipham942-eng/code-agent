import React, { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  ChevronRight,
  Folder,
  ListChecks,
  Loader2,
  MessageSquareText,
  PanelRightOpen,
  Plus,
  Sparkles,
  ScrollText,
} from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
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
import type { SidebarDerivedSessions } from './useSidebarDerivedSessions';
import type { SidebarSessionActions } from './useSidebarSessionActions';
import {
  ensureNeoWorkCardLiveUpdates,
  selectNeoWorkCardBadgeForProject,
  useNeoWorkCardStore,
} from '../../../stores/neoWorkCardStore';

/** 单个分组默认最多平铺多少条会话，超出折叠成「展开全部」。同工作空间历史过多时避免长列表淹没侧栏。 */
const SESSION_ROW_CAP = 5;

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
  handleOpenWorkspaceAssets: SidebarSessionActions['handleOpenWorkspaceAssets'];
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
  const {
    backgroundTaskMap,
    sessionRuntimes,
    sessionStates,
    hasPendingApprovalForSession,
    reviewItemsBySessionId,
    currentSessionId,
  } = sessionItemProps;

  const [showAllRows, setShowAllRows] = useState(false);
  const openProjectCollaborationPage = useAppStore((state) => state.openProjectCollaborationPage);
  const neoBadge = useNeoWorkCardStore(useShallow((state) => selectNeoWorkCardBadgeForProject(state, group.projectId ?? null)));
  const loadNeoWorkCardsForProject = useNeoWorkCardStore((state) => state.loadForProject);
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
  useEffect(() => {
    ensureNeoWorkCardLiveUpdates();
  }, []);
  useEffect(() => {
    if (!group.projectId || group.isUncategorized) return;
    void loadNeoWorkCardsForProject(group.projectId).catch(() => {});
  }, [group.isUncategorized, group.projectId, loadNeoWorkCardsForProject]);
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
              {summary.unfinishedCount > 0 && (
                <span className="shrink-0 rounded-full border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                  {summary.unfinishedCount} 未完成
                </span>
              )}
            </span>
          </span>
        </button>
        {!group.isUncategorized && (
          <button
            type="button"
            data-testid="sidebar-neo-collab-entry"
            aria-label={`打开 ${summary.displayName} Neo 项目合作面板，待审 ${neoBadge.reviewCount}，结果待看 ${neoBadge.resultReviewCount}`}
            title={`打开 ${summary.displayName} Neo 项目合作面板 · 待审 ${neoBadge.reviewCount} · 结果待看 ${neoBadge.resultReviewCount}`}
            onClick={(event) => {
              event.stopPropagation();
              openProjectCollaborationPage(group.projectId ?? null);
            }}
            className="ml-1 inline-flex h-5 shrink-0 items-center gap-1 rounded border border-violet-500/20 bg-violet-500/10 px-1.5 text-[10px] font-medium text-violet-200 transition-colors hover:bg-violet-500/20 hover:text-violet-100 focus:outline-hidden"
          >
            <Sparkles className="h-3 w-3" />
            Neo {neoBadge.openCount}
            {(neoBadge.reviewCount > 0 || neoBadge.resultReviewCount > 0) && (
              <span className="text-violet-100/80">
                审{neoBadge.reviewCount} 结{neoBadge.resultReviewCount}
              </span>
            )}
          </button>
        )}
        {/* 项目操作簇：控制台 / 详情 / 产物 / 新建 — 默认隐藏，hover 或聚焦时浮现。
            绝对定位覆盖在右侧(sticky header 提供定位上下文),而非占流内宽度:
            occupy 流内宽度(opacity-0 或 group-hover:flex)会在窄侧边栏把"未完成"和
            "Neo"徽标挤到重叠(叠字)。绝对定位 + 不透明底,hover 时浮在右侧盖住 Neo
            徽标区,流内徽标永不被挤。 */}
        <div className="absolute right-1 top-1/2 z-10 hidden -translate-y-1/2 items-center rounded-md bg-zinc-900 pl-1 group-hover:flex group-focus-within:flex">
        {!group.isUncategorized && (
          <button
            type="button"
            aria-label={`打开 ${summary.displayName} 项目控制台`}
            title={`打开 ${summary.displayName} 项目控制台`}
            aria-pressed={drawerOpen ? 'true' : 'false'}
            onClick={() => {
              setProjectDrawerKey(group.key);
            }}
            className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
          </button>
        )}
        {!group.isUncategorized && (
          <button
            type="button"
            aria-label={detailsExpanded ? `收起 ${summary.displayName} 项目详情` : `展开 ${summary.displayName} 项目详情`}
            title={detailsExpanded ? `收起 ${summary.displayName} 项目详情` : `展开 ${summary.displayName} 项目详情`}
            onClick={() => {
              setExpandedProjectDetails((previous) => ({
                ...previous,
                [group.key]: !previous[group.key],
              }));
            }}
            className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
          >
            <ListChecks className="h-3.5 w-3.5" />
          </button>
        )}
        {!group.isUncategorized && (
          <button
            type="button"
            aria-label={`打开 ${summary.displayName} 产物与资产`}
            title={`打开 ${summary.displayName} 产物与资产`}
            onClick={handleOpenWorkspaceAssets}
            className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
          >
            <ScrollText className="h-3.5 w-3.5" />
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
        </div>
      </div>
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
      {expanded && (() => {
        // 折叠长列表：默认只平铺前 SESSION_ROW_CAP 条。搜索态或手动展开时全显；
        // 当前会话若排在 cap 之后，只把窗口扩到「刚好露出它」，其余仍折叠（不会因此把整列摊开）。
        const currentIndexInGroup = group.sessions.findIndex((session) => session.id === currentSessionId);
        const effectiveCap = hasSearchFilters || showAllRows
          ? group.sessions.length
          : Math.max(SESSION_ROW_CAP, currentIndexInGroup + 1);
        const visibleSessions = group.sessions.slice(0, effectiveCap);
        const hiddenCount = group.sessions.length - visibleSessions.length;
        const canToggle = !hasSearchFilters && (hiddenCount > 0 || showAllRows);
        return (
          <div
            className={expansionView.rowsClassName}
            data-sidebar-group-rows={group.key}
          >
            {group.sessions.length === 0 ? (
              <div className="px-3 py-1 text-xs text-zinc-600">暂无对话</div>
            ) : (
              <>
                {visibleSessions.map((session, index) => (
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
                ))}
                {canToggle && (
                  <button
                    type="button"
                    onClick={() => setShowAllRows((value) => !value)}
                    className="w-full px-3 py-1 text-left text-[11px] text-zinc-500 transition-colors hover:text-zinc-300 focus:outline-hidden"
                  >
                    {showAllRows ? '收起' : `展开全部 ${group.sessions.length} 条`}
                  </button>
                )}
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
};
