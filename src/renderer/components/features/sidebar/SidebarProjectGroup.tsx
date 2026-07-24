import React, { useState, type Dispatch, type SetStateAction } from 'react';
import {
  ChevronRight,
  Folder,
  ListChecks,
  Loader2,
  MessageSquareText,
  PanelRightOpen,
  Plus,
  ScrollText,
  Settings2,
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
import type { SidebarDerivedSessions } from './useSidebarDerivedSessions';
import type { SidebarSessionActions } from './useSidebarSessionActions';
import { useI18n } from '../../../hooks/useI18n';
import { ProjectSettingsDialog } from '../../ProjectSettingsDialog';

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
  const { t } = useI18n();
  const p = t.sidebarProject;
  const {
    backgroundSessionMap,
    sessionRuntimes,
    sessionStates,
    hasNeedsInputForSession,
    reviewItemsBySessionId,
    currentSessionId,
  } = sessionItemProps;

  const [showAllRows, setShowAllRows] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const IconComponent = group.isUncategorized ? MessageSquareText : Folder;
  const projectMeta = group.projectId ? projectMetaById[group.projectId] : undefined;
  const summary = buildSidebarProjectSummary({
    group,
    backgroundSessionMap,
    sessionRuntimes,
    sessionStates,
    hasNeedsInputForSession,
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
    ? p.plainChatTitle
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
        {/* 分组头对齐约定(2026-07-02 拍板)：图标+名称左对齐、整行垂直居中；
            展开收起 chevron 不常驻，hover/聚焦时才出现在名称右侧(参考 Codex)；
            未完成数右对齐，用"色球+数字"与会话行的状态圆点同一视觉语言，不用文字胶囊。 */}
        <button
          type="button"
          title={expansionView.toggleTitle}
          aria-label={expansionView.toggleAriaLabel}
          aria-disabled={expansionView.forceExpanded ? 'true' : undefined}
          onClick={() => handleToggleWorkspaceGroup(group.key, expansionView)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <IconComponent className="w-3 h-3 shrink-0 text-zinc-500" />
          <span className="truncate text-xs font-medium text-zinc-400">{summary.displayName}</span>
          <ChevronRight
            className={`w-3 h-3 shrink-0 text-zinc-500 transition-all opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 ${
              expanded ? 'rotate-90' : ''
            }`}
          />
        </button>
        {summary.unfinishedCount > 0 && (
          <span
            data-testid="sidebar-group-unfinished"
            className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-400/90 px-1 text-[10px] font-medium tabular-nums text-zinc-900"
            title={p.unfinishedCount.replace('{count}', String(summary.unfinishedCount))}
            aria-label={p.unfinishedCount.replace('{count}', String(summary.unfinishedCount))}
          >
            {summary.unfinishedCount}
          </span>
        )}
        {/* Neo 协作徽标已按拍板移除(2026-07-02)：入口走账号菜单"Neo 协同" */}
        {/* 项目操作簇：控制台 / 详情 / 产物 / 新建 — 默认隐藏，hover 或聚焦时浮现。
            绝对定位覆盖在右侧(sticky header 提供定位上下文),而非占流内宽度:
            occupy 流内宽度(opacity-0 或 group-hover:flex)会在窄侧边栏把"未完成"和
            "Neo"徽标挤到重叠(叠字)。绝对定位 + 不透明底,hover 时浮在右侧盖住 Neo
            徽标区,流内徽标永不被挤。 */}
        <div className="absolute right-1 top-1/2 z-10 hidden -translate-y-1/2 items-center rounded-md bg-zinc-900 pl-1 group-hover:flex group-focus-within:flex">
        {!group.isUncategorized && (
          <button
            type="button"
            aria-label={`编辑项目 ${summary.displayName}`}
            title="编辑项目"
            onClick={() => setSettingsOpen(true)}
            className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        )}
        {!group.isUncategorized && (
          <button
            type="button"
            aria-label={p.openConsole.replace('{name}', summary.displayName)}
            title={p.openConsole.replace('{name}', summary.displayName)}
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
            aria-label={(detailsExpanded ? p.collapseDetails : p.expandDetails).replace('{name}', summary.displayName)}
            title={(detailsExpanded ? p.collapseDetails : p.expandDetails).replace('{name}', summary.displayName)}
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
            aria-label={p.openAssets.replace('{name}', summary.displayName)}
            title={p.openAssets.replace('{name}', summary.displayName)}
            onClick={handleOpenWorkspaceAssets}
            className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
          >
            <ScrollText className="h-3.5 w-3.5" />
          </button>
        )}
        {!group.isUncategorized && (
          <button
            type="button"
            aria-label={p.newSessionIn.replace('{name}', summary.displayName)}
            title={p.newSessionIn.replace('{name}', summary.displayName)}
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
      {group.projectId && (
        <ProjectSettingsDialog
          projectId={group.projectId}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
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
              <div className="px-3 py-1 text-xs text-zinc-600">{p.noSessions}</div>
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
                    {showAllRows ? p.collapse : p.expandAll.replace('{count}', String(group.sessions.length))}
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
