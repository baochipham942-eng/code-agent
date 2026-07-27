import React, { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  ListChecks,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  PanelRightOpen,
  ScrollText,
  Settings2,
  SquarePen,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { isWebMode } from '../../../utils/platform';
import ipcService from '../../../services/ipcService';
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
  setProjectMetaById: SidebarDerivedSessions['setProjectMetaById'];
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
  setProjectMetaById,
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
  // 项目行「⋯」菜单开合态（2026-07-28 侧栏工作区入口重构：hover 图标簇收敛为 ⋯+新建）。
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);
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
  // 「选择工作目录」（2026-07-28 侧栏工作区入口重构）：复用 WORKSPACE.selectDirectory
  // （main 侧会写 app 工作目录 + 记 recentDirectories，用法同 WorkspaceSettings）。
  // 选中后在该目录下新建任务——新会话按 workingDirectory 归组，所选目录随即
  // 以工作区分组出现在侧栏，取代已退役的侧栏左上角「选择目录」行（批C2）。
  const handlePickWorkspaceDirectory = async () => {
    setMenuOpen(false);
    try {
      const next = await ipcService.invokeDomain<string | null>(IPC_DOMAINS.WORKSPACE, 'selectDirectory');
      if (next) {
        await createWorkspaceChat(next, next);
      }
    } catch (error) {
      console.error('Failed to pick working directory:', error);
    }
  };
  return (
    <div
      className="mb-2.5"
      data-sidebar-group-phase={expansionView.phase}
    >
      <div
        className="group sticky top-0 z-20 flex items-center gap-1.5 w-full pl-2 pr-3 py-1.5 bg-zinc-900 backdrop-blur-sm text-left hover:bg-zinc-800/40 transition-colors"
        title={title}
      >
        {/* 分组头对齐约定(2026-07-02 拍板,2026-07-26 强化)：图标+名称左对齐、整行垂直居中；
            展开收起 chevron 不常驻，hover/聚焦时才出现在名称右侧(参考 Codex)；
            未完成数右对齐，用"色球+数字"与会话行的状态圆点同一视觉语言，不用文字胶囊。
            07-26 Codex 式分组：分组头升格作一等工作区，会话行整体缩进，组间距 10px。
            07-27 对齐规范（数值是在真实 DOM 里量出来的，不是推算）：
            左轨 42px —— 入口区行 8(容器)+16(图标)+... = 文字 42；分组头 px-2 同轨；
            会话行区 ml-[10px] 使行容器落在 18，行内 pl-0 + 16px 前导槽 + gap-2 = 18+24 = 42；
            展开行没有前导槽，用 pl-6(24) 补齐到同一条 42。
            右轨基准 = 账号区箭头（cx=212，right=220）：分组头 pr-3、会话行 pr-3，
            使角标 / 状态点 / 账号箭头三者右缘同为 220、中心同为 212（实测口径）。 */}
        <button
          type="button"
          title={expansionView.toggleTitle}
          aria-label={expansionView.toggleAriaLabel}
          aria-disabled={expansionView.forceExpanded ? 'true' : undefined}
          onClick={() => handleToggleWorkspaceGroup(group.key, expansionView)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <IconComponent className="w-4 h-4 shrink-0 text-zinc-400" />
          <span className="truncate text-[13px] font-medium leading-5 text-zinc-200">{summary.displayName}</span>
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
        {/* 项目操作收敛为两个按钮（2026-07-28 产品负责人拍板）：「⋯」菜单 + 「新建」。
            原 hover 图标簇（设置/控制台/详情/产物）全部收进 ⋯ 菜单，另加「选择工作目录」；
            新建沿用侧栏左上角新任务的 SquarePen 图标。仍是默认隐藏、hover/聚焦浮现 +
            绝对定位覆盖右侧（不占流内宽度，避免窄侧栏挤叠流内徽标），未分类组不渲染。 */}
        <div className="absolute right-1 top-1/2 z-10 hidden -translate-y-1/2 items-center rounded-md bg-zinc-900 pl-1 group-hover:flex group-focus-within:flex">
        {!group.isUncategorized && (
          <>
          <div className="relative" ref={menuRef}>
            <button /* ds-allow:button: 侧栏分组头 24px 图标触发钮，Button primitive 无对应微尺寸方形变体（同原 hover 图标钮形态） */
              type="button"
              aria-label={p.moreActions.replace('{name}', summary.displayName)}
              title={p.moreActions.replace('{name}', summary.displayName)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((value) => !value)}
              className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <div
                role="menu"
                aria-label={p.moreActions.replace('{name}', summary.displayName)}
                className="absolute right-0 top-full z-30 mt-1 min-w-[180px] rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-xl"
              >
                <button /* ds-allow:button: 下拉菜单行（图标+文字左对齐列表项），Button primitive 居中动作钮形状不适配菜单项 */
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setSettingsOpen(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
                >
                  <Settings2 className="h-3.5 w-3.5 shrink-0" />
                  <span>{p.settings.title}</span>
                </button>
                <button /* ds-allow:button: 下拉菜单行（图标+文字左对齐列表项），Button primitive 居中动作钮形状不适配菜单项 */
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setProjectDrawerKey(group.key);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
                >
                  <PanelRightOpen className="h-3.5 w-3.5 shrink-0" />
                  <span>{p.openConsole.replace('{name}', summary.displayName)}</span>
                </button>
                <button /* ds-allow:button: 下拉菜单行（图标+文字左对齐列表项），Button primitive 居中动作钮形状不适配菜单项 */
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setExpandedProjectDetails((previous) => ({
                      ...previous,
                      [group.key]: !previous[group.key],
                    }));
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
                >
                  <ListChecks className="h-3.5 w-3.5 shrink-0" />
                  <span>{(detailsExpanded ? p.collapseDetails : p.expandDetails).replace('{name}', summary.displayName)}</span>
                </button>
                <button /* ds-allow:button: 下拉菜单行（图标+文字左对齐列表项），Button primitive 居中动作钮形状不适配菜单项 */
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    setMenuOpen(false);
                    handleOpenWorkspaceAssets(e);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
                >
                  <ScrollText className="h-3.5 w-3.5 shrink-0" />
                  <span>{p.openAssets.replace('{name}', summary.displayName)}</span>
                </button>
                {!isWebMode() && (
                  <button /* ds-allow:button: 下拉菜单行（图标+文字左对齐列表项），Button primitive 居中动作钮形状不适配菜单项 */
                    type="button"
                    role="menuitem"
                    onClick={() => { void handlePickWorkspaceDirectory(); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
                  >
                    <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                    <span>{t.sidebar.selectDirectoryTitle}</span>
                  </button>
                )}
              </div>
            )}
          </div>
          <button /* ds-allow:button: 侧栏分组头 24px 图标钮，Button primitive 无对应微尺寸方形变体（同原 + 钮形态） */
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
              <SquarePen className="h-3.5 w-3.5" />
            )}
          </button>
          </>
        )}
    </div>
        {/* 设置对话框挪出 hover 浮现容器：容器离开 hover 会 display:none，
            把开着的对话框一起隐藏（原实现的缺陷）。 */}
        {group.projectId && (
          <ProjectSettingsDialog
            projectId={group.projectId}
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
      {detailsExpanded && !group.isUncategorized && (
        <SidebarProjectDetail
          projectId={group.projectId}
          meta={projectMeta}
          fallbackSessionCount={group.sessions.length}
          onOpenArtifactSession={handleOpenProjectArtifactSession}
          onStartGoal={(goal) => { void handleStartProjectGoal(goal, group.key, group.path); }}
          onMetaChange={(update) => {
            const projectId = group.projectId;
            if (!projectId) return;
            setProjectMetaById((current) => {
              const next = update(current[projectId]);
              return next
                ? { ...current, [projectId]: next }
                : current;
            });
          }}
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
            className={`${expansionView.rowsClassName} ml-[10px]`}
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
                    className="w-full pl-6 pr-3 py-1 text-left text-[11px] text-zinc-500 transition-colors hover:text-zinc-300 focus:outline-hidden"
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
