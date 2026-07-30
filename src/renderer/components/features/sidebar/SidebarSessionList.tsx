// ============================================================================
// SidebarSessionList —— 侧栏会话列表区（加载态 / 空态 / 搜索空态 + 分组渲染）。
// 从 `Sidebar` 巨型组件抽出（god-file 红线治理，批P 第三波前置拆分）：
// props 全量透传现有 state/回调，行为零变化；三分区逻辑后续只加在本组件，不回填主文件。
// ============================================================================

import React, { useCallback } from 'react';
import { ChevronRight, Cloud, Focus, Loader2, MessageSquare, Plus, Search } from 'lucide-react';
import { PLAIN_CHAT_SUMMARY_LABEL } from '@shared/contract/sessionWorkspace';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { useSessionUIStore, type SessionStatusFilter } from '../../../stores/sessionUIStore';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import { localeForLanguage } from '../../../utils/i18nTime';
import { getDisplaySessionTitle, getSessionStatusPresentation } from '../../../utils/sessionPresentation';
import { hasSessionDeliverySignals } from '../../../utils/sessionRecoveryHints';
import {
  buildSidebarSessionTierSections,
  type SidebarSessionTier,
} from '../../../utils/sidebarSessionTiers';
import type { SidebarProjectDrawerSession } from './SidebarProjectDrawer';
import { getSessionTypeLabel } from './SessionTypeFilterBar';
import { SidebarProjectGroup, type SidebarProjectGroupProps } from './SidebarProjectGroup';
import type { SidebarDerivedSessions } from './useSidebarDerivedSessions';

export interface SidebarSessionListProps extends Omit<SidebarProjectGroupProps, 'group' | 'buildProjectDrawerSessions'> {
  groups: SidebarDerivedSessions['workspaceGroupedSessions'];
  isLoading: boolean;
  hasAnySessions: boolean;
  filteredSessionsEmpty: boolean;
  messageSearchLoading: boolean;
  searchQuery: string;
  sessionStatusFilter: SessionStatusFilter;
  activeStatusFilterLabel: string;
  /**
   * 云标留接口不点亮（批P 第三波刻意为之）：渲染逻辑已写好（协作空间节头点亮云图标），
   * 但本分支 contract 没有 cloudProjectId（在另一条分支上），调用方恒传 undefined；
   * 合流后把「该空间是否已绑云身份」接进这个 prop 即一行点亮。
   */
  cloudBadge?: boolean;
  /** 快速对话分区节头「+」：与侧栏顶部「新任务」同一个动作（纯对话，不复制逻辑）。 */
  handleNewChat: () => void | Promise<void>;
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
  sessionItemProps,
  cloudBadge,
  handleNewChat,
}) => {
  const { t, language } = useI18n();
  const sb = t.sidebar;
  const p = t.sidebarProject;
  // 分区节头交互状态（折叠持久化、solo 会话内）都在 sessionUIStore；新建空间入口复用 appStore 的 openProjectSpacePage。
  const collapsedTiers = useSessionUIStore((state) => state.collapsedTiers);
  const setTierCollapsed = useSessionUIStore((state) => state.setTierCollapsed);
  const soloTier = useSessionUIStore((state) => state.soloTier);
  const setSoloTier = useSessionUIStore((state) => state.setSoloTier);
  const openProjectSpacePage = useAppStore((state) => state.openProjectSpacePage);
  // 项目抽屉行数据装配随列表区一起迁出（god-file 治理第二刀）：全部依赖都在
  // sessionItemProps / i18n 里，Sidebar 主文件不再持有这段映射。
  const {
    backgroundSessionMap,
    sessionRuntimes,
    sessionStates,
    hasNeedsInputForSession,
    replayEvidenceBySessionId,
    reviewItemsBySessionId,
    currentSessionId,
  } = sessionItemProps;
  const buildProjectDrawerSessions = useCallback(
    (groupSessions: SessionWithMeta[]): SidebarProjectDrawerSession[] =>
      groupSessions.map((session) => {
        const sessionRuntime = sessionRuntimes.get(session.id);
        const backgroundSession = backgroundSessionMap.get(session.id);
        const status = getSessionStatusPresentation({
          backgroundSession,
          runtime: sessionRuntime,
          taskState: sessionStates[session.id],
          messageCount: session.messageCount,
          turnCount: session.turnCount,
          sessionStatus: session.status,
          hasNeedsInput: hasNeedsInputForSession(session.id),
        });
        const latestActivityAt = Math.max(
          session.updatedAt || 0,
          sessionRuntime?.lastActivityAt || 0,
          backgroundSession?.backgroundedAt || 0,
        );
        const replayEvidenceCount = replayEvidenceBySessionId.get(session.id)?.length ?? 0;
        const pendingReviewCount = (reviewItemsBySessionId[session.id] ?? []).filter(
          (item) => item.reviewStatus === 'pending',
        ).length;
        const snapshotSummary = session.workbenchSnapshot?.summary?.trim();
        const hasMeaningfulSummary = Boolean(snapshotSummary && snapshotSummary !== PLAIN_CHAT_SUMMARY_LABEL);

        return {
          id: session.id,
          title: getDisplaySessionTitle(session.title),
          statusLabel:
            status.kind === 'error'
              ? t.common.error
              : status.kind === 'incomplete'
                ? t.common.incomplete
                : status.label,
          statusToneClassName: status.toneClassName,
          showStatusBadge: status.showBadge,
          typeLabel: getSessionTypeLabel(session.type),
          summary: hasMeaningfulSummary ? snapshotSummary : undefined,
          lastActiveTitle: new Date(latestActivityAt).toLocaleString(localeForLanguage(language)),
          workingDirectory: session.workingDirectory,
          gitBranch: session.gitBranch,
          prLabel: session.prLink ? `PR #${session.prLink.number}` : undefined,
          isCurrent: session.id === currentSessionId,
          turnCount: session.turnCount,
          messageCount: session.messageCount,
          hasDeliverySignals: hasSessionDeliverySignals(session, {
            hasReplay: replayEvidenceCount > 0,
          }),
          replayEvidenceCount,
          pendingReviewCount,
        };
      }),
    [
      backgroundSessionMap,
      currentSessionId,
      hasNeedsInputForSession,
      replayEvidenceBySessionId,
      reviewItemsBySessionId,
      sessionRuntimes,
      sessionStates,
      t,
    ],
  );
  // 三分区归位（ADR-053）：判据与排序规则全部在 sidebarSessionTiers，
  // 组内/组间排序不动，空分区整节不出现在返回里（含节头）。
  const tierSections = buildSidebarSessionTierSections(groups, projectMetaById);
  const tierLabels: Record<SidebarSessionTier, string> = {
    space: p.tierSpace,
    project: p.tierProject,
    quick: p.tierQuick,
  };
  // 「只看本分区」：solo 生效时只保留命中分区；solo 目标已为空分区（整节省略）时回退全部，
  // 避免列表整片消失却没有任何提示。solo 与会话级 statusFilter 管线天然正交（一个筛分区、一个筛会话）。
  const visibleSections =
    soloTier && tierSections.some((section) => section.tier === soloTier)
      ? tierSections.filter((section) => section.tier === soloTier)
      : tierSections;
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
        /* Workspace/project grouped view, including search and status-filtered results.
           三分区渲染：节头排版对齐能力区行制度（text-sm 标题 + text-[11px] 计数，不发明新字号）。
           垂直节奏（批P 第五波①，探针实测修前 16/10/0/0 无规律）：
           区间断点统一 8px —— 能力区 pb-2 之后本容器不再叠 pt（修前 py-2 叠出 16），
           分区间 gap-2(8)（修前靠末组 mb-2.5 混出 10）；组间距仍 10（组列 gap-2.5，见下）。 */
        <div className="flex flex-col gap-2 pb-2">
          {visibleSections.map((section) => {
            const isCollapsed = Boolean(collapsedTiers[section.tier]);
            const isSolo = soloTier === section.tier;
            return (
            <section key={section.tier} aria-label={tierLabels[section.tier]} data-testid={`sidebar-tier-${section.tier}`}>
              {/* 节头 = 折叠主钮（原生 button，Enter/Space 可达）+ 计数 + solo/创建图标钮。
                  图标钮是主钮的兄弟而非子元素，仍显式 stopPropagation 防未来结构调整误触折叠。 */}
              <div className="flex items-center gap-1 px-1.5 pb-1 pt-2">
                <button /* ds-allow:button: 分区节头折叠行（chevron+标题左对齐列表行形态），Button primitive 居中动作钮形状不适配行布局 */
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-label={isCollapsed ? p.tierExpand : p.tierCollapse}
                  title={isCollapsed ? p.tierExpand : p.tierCollapse}
                  data-testid={`sidebar-tier-toggle-${section.tier}`}
                  onClick={() => setTierCollapsed(section.tier, !isCollapsed)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <ChevronRight
                    className={`h-3 w-3 shrink-0 text-zinc-600 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-500">{tierLabels[section.tier]}</span>
                </button>
                {section.tier === 'space' && cloudBadge && (
                  <span className="flex-shrink-0" title={p.tierCloudBadgeTitle} data-testid="sidebar-tier-cloud-badge">
                    <Cloud className="h-3.5 w-3.5 text-sky-400" aria-label={p.tierCloudBadgeTitle} />
                  </span>
                )}
                {/* 计数折叠态也保留：折叠后它是这个分区唯一的信息密度。 */}
                <span className="flex-shrink-0 text-[11px] text-zinc-600 tabular-nums">{section.sessionCount}</span>
                <button /* ds-allow:button: 节头 20px 图标钮，Button primitive 无对应微尺寸方形变体（同分组头图标钮形态） */
                  type="button"
                  aria-pressed={isSolo}
                  aria-label={isSolo ? p.tierSoloExit : p.tierSolo}
                  title={isSolo ? p.tierSoloExit : p.tierSolo}
                  data-testid={`sidebar-tier-solo-${section.tier}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSoloTier(isSolo ? null : section.tier);
                  }}
                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded focus:outline-hidden ${
                    isSolo
                      ? 'bg-zinc-700/70 text-primary-400'
                      : 'text-zinc-600 hover:bg-zinc-700/70 hover:text-zinc-300'
                  }`}
                >
                  <Focus className="h-3 w-3" />
                </button>
                {/* 独立空间分区不放「+」：产品上没有「新建独立空间」入口（独立空间由工作目录会话自然长出来），
                    新写一份创建流超出本任务范围。 */}
                {section.tier === 'space' && (
                  <button /* ds-allow:button: 节头 20px 图标钮，Button primitive 无对应微尺寸方形变体（同分组头图标钮形态） */
                    type="button"
                    aria-label={p.tierNewSpace}
                    title={p.tierNewSpace}
                    data-testid="sidebar-tier-new-space"
                    onClick={(e) => {
                      e.stopPropagation();
                      openProjectSpacePage();
                    }}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-600 hover:bg-zinc-700/70 hover:text-zinc-300 focus:outline-hidden"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                )}
                {section.tier === 'quick' && (
                  <button /* ds-allow:button: 节头 20px 图标钮，Button primitive 无对应微尺寸方形变体（同分组头图标钮形态） */
                    type="button"
                    aria-label={p.tierNewQuickChat}
                    title={p.tierNewQuickChat}
                    data-testid="sidebar-tier-new-quick"
                    disabled={isCreatingSession}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleNewChat();
                    }}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-600 hover:bg-zinc-700/70 hover:text-zinc-300 focus:outline-hidden disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                )}
              </div>
              {/* 组列：组间距 10px 由本列 gap-2.5 统一给（批P 第五波①：原靠组根 mb-2.5，
                  末组的外边距会混进分区间距，三段节奏量出来 16/10 不一致；移进列内后
                  分区间距由外层 gap-2 独占，永远 8px）。 */}
              {!isCollapsed && (
                <div className="flex flex-col gap-2.5">
                  {section.groups.map((group) => (
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
            </section>
            );
          })}
        </div>
      )}
    </div>
  );
};
