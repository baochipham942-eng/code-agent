 
// ============================================================================
// Sidebar - Linear-style session list with grouped cards and session management
// ============================================================================

import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useSessionStore, initializeSessionStore, type SessionWithMeta } from '../stores/sessionStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useSessionUIStore } from '../stores/sessionUIStore';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { useWorkbenchPresetStore } from '../stores/workbenchPresetStore';
import { useAuthStore } from '../stores/authStore';
import { useTaskStore } from '../stores/taskStore';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useWorkflowStore } from '../stores/workflowStore';
import {
  MessageSquare,
  Loader2,
  User,
  Settings,
  LogIn,
  LogOut,
  ChevronDown,
  Trash2,
  Search,
  ChevronRight,
  FlaskConical,
  Clock3,
  CalendarDays,
  Monitor,
  Globe,
  MousePointerClick,
  ScrollText,
  Activity,
  Brain,
  Users,
  UsersRound,
  Ticket,
  Download,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { useUIStore } from '../stores/uiStore';
import { IconButton, UndoToast } from './primitives';
import { createLogger } from '../utils/logger';
import { SessionContextMenu, type ContextMenuItem } from './features/sidebar/SessionContextMenu';
import { type SidebarProjectDrawerSession } from './features/sidebar/SidebarProjectDrawer';
import { SidebarProjectGroup } from './features/sidebar/SidebarProjectGroup';
import { SidebarCapabilityZone } from './features/sidebar/SidebarCapabilityZone';
import type { SidebarSessionItemSharedProps } from './features/sidebar/SidebarSessionItem';
import type { SessionAutomationSessionSummary } from '@shared/contract';
import { sessionAutomationClient } from '../services/sessionAutomationClient';
import { SessionReplaySummaryDialog } from './features/sidebar/SessionReplaySummaryDialog';
import { getSessionTypeLabel } from './features/sidebar/SessionTypeFilterBar';
import { AccountMenuItem, AccountMenuLabel } from './features/sidebar/sidebarPresentation';
import { useI18n } from '../hooks/useI18n';
import { formatRelativeTime } from '../utils/i18nTime';
import ipcService from '../services/ipcService';
import { getDisplaySessionTitle, getSessionStatusPresentation } from '../utils/sessionPresentation';
import { hasSessionDeliverySignals } from '../utils/sessionRecoveryHints';
import { isOptionalUpdateAvailable } from '../utils/updatePrompt';
import { canAccessFeature } from '../utils/accessControl';
import { buildSessionContextMenuItems } from './features/sidebar/sessionContextMenuItems';
import { useSidebarDerivedSessions } from './features/sidebar/useSidebarDerivedSessions';
import { useSidebarSessionActions } from './features/sidebar/useSidebarSessionActions';
import { useSidebarRowActions, resolveRuntimeLogsDir } from './features/sidebar/useSidebarRowActions';
import { SidebarStatusFilterDropdown } from './features/sidebar/SidebarStatusFilterDropdown';
import { SidebarSearchDialog } from './features/sidebar/SidebarSearchDialog';
import { NeoBrandMark } from './features/sidebar/NeoBrandMark';
import { SidebarNewTaskRow } from './features/sidebar/SidebarNewTaskRow';
import {
  buildSessionStatusFilterOptions,
  buildSessionStatusFilterLabels,
  buildTrajectoryFailureFilterOptions,
  buildTrajectoryReviewFilterLabels,
} from './features/sidebar/sidebarFilterOptions';
import type { StructuredReplay } from '@shared/contract/evaluation';
import type {
  AgentTrajectoryDatasetRole,
  AgentTrajectorySessionQualitySummary,
} from '@shared/contract/agentTrajectory';
import { UNSORTED_PROJECT_ID } from '@shared/contract/project';
import { PLAIN_CHAT_SUMMARY_LABEL } from '@shared/contract/sessionWorkspace';

export { resolveRuntimeLogsDir };

const logger = createLogger('Sidebar');

export function isAccountMenuEventOutside(
  accountMenuElement: { contains: (node: Node) => boolean } | null,
  target: EventTarget | null,
): boolean {
  if (!accountMenuElement || !target) return false;
  return !accountMenuElement.contains(target as Node);
}

export const Sidebar: React.FC = () => {
  const { t } = useI18n();
  const sb = t.sidebar;
  const {
    clearPlanningState,
    setShowSettings,
    openSettingsTab,
    setShowCronCenter,
    setShowPromptManager,
    setWorkingDirectory,
    showLab,
    setShowLab,
    showCronCenter,
    showTimeCapabilityCenter,
    setShowTimeCapabilityCenter,
    showDesktopPanel,
    setShowDesktopPanel,
    showBrowserSurfacePanel,
    setShowBrowserSurfacePanel,
    showActivityPanel,
    setShowActivityPanel,
    showKnowledgeMemoryPanel,
    setShowKnowledgeMemoryPanel,
    showComputerUsePanel,
    setShowComputerUsePanel,
    showProjectCollaborationPage,
    openProjectCollaborationPage,
    optionalUpdateInfo,
    setShowOptionalUpdateModal,
    openWorkspacePreview,
  } = useAppStore();
  const applySessionWorkbenchPreset = useComposerStore((state) => state.applySessionWorkbenchPreset);
  const applyWorkbenchPreset = useComposerStore((state) => state.applyWorkbenchPreset);
  const applyWorkbenchRecipe = useComposerStore((state) => state.applyWorkbenchRecipe);
  const savedWorkbenchPresets = useWorkbenchPresetStore((state) => state.presets);
  const savedWorkbenchRecipes = useWorkbenchPresetStore((state) => state.recipes);
  const saveWorkbenchPresetFromSession = useWorkbenchPresetStore((state) => state.savePresetFromSession);
  const durableBackgroundTasks = useBackgroundTaskStore((state) => state.tasks);
  const workflowRuns = useWorkflowStore((state) => state.runs);
  const {
    sessions,
    currentSessionId,
    isLoading,
    createSession,
    switchSession,
    archiveSession,
    unarchiveSession,
    unreadSessionIds,
    sessionRuntimes,
    renameSession,
  } = useSessionStore();

  const {
    pinnedSessionIds,
    togglePin,
    multiSelectMode,
    selectedSessionIds,
    toggleSelection,
    clearSelection,
    batchDelete,
  } = useSelectionStore();

  const {
    searchQuery,
    setSearchQuery,
    sessionStatusFilter,
    setSessionStatusFilter,
    trajectoryTierFilter,
    setTrajectoryTierFilter,
    trajectoryFailureFilter,
    setTrajectoryFailureFilter,
    trajectoryReviewFilter,
    setTrajectoryReviewFilter,
    setPendingSearchJump,
    softDelete,
    undoDelete,
    pendingDelete,
    expandedWorkspaces,
    setWorkspaceExpanded,
  } = useSessionUIStore();

  const {
    user,
    isAuthenticated,
    setShowAuthModal,
    signOut,
    sessionTrustState,
    authBackendAvailable,
    hasCachedAdminClaim,
  } = useAuthStore();
  const canOpenPromptManager = canAccessFeature('prompt.manager', user);
  const canOpenUserDashboard = canAccessFeature('settings.users', user);
  const canOpenInviteCodes = canAccessFeature('settings.invites', user);
  const canOpenSessionReplay = canAccessFeature('eval.replay', user);
  const isVerifiedAdmin = user?.isAdmin === true;
  const isAdminPendingVerification = !isVerifiedAdmin && hasCachedAdminClaim && sessionTrustState === 'cached';
  const adminPendingTitle =
    authBackendAvailable === false ? sb.adminPendingLoginFailed : sb.adminPendingVerifying;
  const sessionStates = useTaskStore((state) => state.sessionStates);

  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [, setAppVersion] = useState<string>('');
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [statusFilterOpen, setStatusFilterOpen] = useState(false);
  const statusFilterRef = useRef<HTMLDivElement>(null);
  const [showAccountAdvancedTools, setShowAccountAdvancedTools] = useState(false);
  const [creatingSessionMode, setCreatingSessionMode] = useState<'current' | null>(null);
  const [creatingWorkspaceKey, setCreatingWorkspaceKey] = useState<string | null>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const isCreatingSession = creatingSessionMode !== null;
  const hasActiveAdvancedTool = Boolean(
    showLab || showTimeCapabilityCenter || showDesktopPanel || showBrowserSurfacePanel,
  );
  const advancedToolsOpen = showAccountAdvancedTools || hasActiveAdvancedTool;
  const currentSessionProjectId = useMemo(() => {
    const session = sessions.find((item) => item.id === currentSessionId);
    return session?.projectId && session.projectId !== UNSORTED_PROJECT_ID ? session.projectId : null;
  }, [currentSessionId, sessions]);

  useEffect(() => {
    if (!showUserMenu) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      if (isAccountMenuEventOutside(accountMenuRef.current, event.target)) {
        setShowUserMenu(false);
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (isAccountMenuEventOutside(accountMenuRef.current, event.target)) {
        setShowUserMenu(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowUserMenu(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showUserMenu]);

  // 状态筛选下拉：点外面 / Esc 关闭
  useEffect(() => {
    if (!statusFilterOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (statusFilterRef.current && !statusFilterRef.current.contains(event.target as Node)) {
        setStatusFilterOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setStatusFilterOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [statusFilterOpen]);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    session: SessionWithMeta;
  } | null>(null);
  const [replayDialog, setReplayDialog] = useState<{
    sessionId: string;
    sessionTitle: string;
    replay: StructuredReplay;
  } | null>(null);

  // 内联重命名状态
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 初始化：加载会话列表
  useEffect(() => {
    initializeSessionStore();
  }, []);

  // 获取应用版本号
  useEffect(() => {
    const loadVersion = async () => {
      try {
        const version = await ipcService.invoke(IPC_CHANNELS.APP_GET_VERSION);
        if (version) {
          setAppVersion(version);
        }
      } catch (error) {
        logger.error('Failed to get app version', error);
      }
    };
    loadVersion();
  }, []);

  const {
    backgroundSessionMap,
    replayEvidenceBySessionId,
    hasNeedsInputForSession,
    currentProjectSearchSessionIds,
    effectiveSearchScope,
    setSearchScope,
    messageSearchHitsBySessionId,
    messageSearchLoading,
    searchResultSessions,
    reviewItemsBySessionId,
    trajectoryQualityBySessionId,
    mergeTrajectoryQualitySummary,
    filteredSessions,
    workspaceGroupedSessions,
    projectMetaById,
    setProjectMetaById,
  } = useSidebarDerivedSessions({ canOpenSessionReplay });

  const [automationSummariesBySessionId, setAutomationSummariesBySessionId] = useState<
    Record<string, SessionAutomationSessionSummary>
  >({});
  const visibleSessionIds = useMemo(
    () => workspaceGroupedSessions.flatMap((group) => group.sessions.map((session) => session.id)),
    [workspaceGroupedSessions],
  );
  const visibleSessionIdsKey = visibleSessionIds.join('\n');

  useEffect(() => {
    if (visibleSessionIds.length === 0) {
      setAutomationSummariesBySessionId({});
      return undefined;
    }

    let cancelled = false;
    void sessionAutomationClient
      .summarizeSessions(visibleSessionIds)
      .then((summaries) => {
        if (cancelled) return;
        setAutomationSummariesBySessionId(summaries ?? {});
      })
      .catch((error) => {
        if (cancelled) return;
        logger.warn('Failed to load sidebar automation summaries', {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        setAutomationSummariesBySessionId({});
      });

    return () => {
      cancelled = true;
    };
  }, [visibleSessionIdsKey]);

  const [expandedProjectDetails, setExpandedProjectDetails] = useState<Record<string, boolean>>({});
  const [projectDrawerKey, setProjectDrawerKey] = useState<string | null>(null);
  const [collapsingWorkspaces, setCollapsingWorkspaces] = useState<Record<string, boolean>>({});
  // Keep new local state after the legacy Sidebar state sequence; several renderer tests
  // intentionally inject historical context/review state by hook index.
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const collapseTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(
    () => () => {
      Object.values(collapseTimersRef.current).forEach(clearTimeout);
      collapseTimersRef.current = {};
    },
    [],
  );

  const {
    handleToggleWorkspaceGroup,
    handleNewChat,
    createWorkspaceChat,
    handleNewWorkspaceChat,
    handleSelectSession,
    handleArchiveSession,
    handleOpenWorkspaceAssets,
    handleOpenSessionAssets,
    handleOpenProjectArtifactSession,
    handleStartProjectGoal,
    handleRenameSidebarProject,
    handleSetSidebarProjectStatus,
    handleSetSidebarProjectDescription,
    handleSelectMessageSearchHit,
  } = useSidebarSessionActions({
    collapseTimersRef,
    setCollapsingWorkspaces,
    setWorkspaceExpanded,
    isCreatingSession,
    creatingWorkspaceKey,
    setCreatingSessionMode,
    setCreatingWorkspaceKey,
    createSession,
    clearPlanningState,
    setWorkingDirectory,
    multiSelectMode,
    toggleSelection,
    searchQuery,
    messageSearchHitsBySessionId,
    setPendingSearchJump,
    currentSessionId,
    switchSession,
    unarchiveSession,
    archiveSession,
    openWorkspacePreview,
    setProjectMetaById,
    t,
  });

  const showToast = useUIStore((state) => state.showToast);

  const {
    saveExportToDownloads,
    openRuntimeLogsFolder,
    handleOpenSessionReplay,
    handleOpenReplayEvidence,
    handleContextMenu,
    handleDoubleClick,
    handleRenameSubmit,
    handleRenameKeyDown,
  } = useSidebarRowActions({
    showToast,
    canOpenSessionReplay,
    setReplayDialog,
    setContextMenu,
    renamingId,
    renameValue,
    setRenamingId,
    setRenameValue,
    renameInputRef,
    renameSession,
    t,
  });

  const getContextMenuItems = useCallback(
    (session: SessionWithMeta): ContextMenuItem[] =>
      buildSessionContextMenuItems(session, {
        pinnedSessionIds,
        savedWorkbenchPresets,
        savedWorkbenchRecipes,
        setWorkingDirectory,
        applyWorkbenchPreset,
        applyWorkbenchRecipe,
        applySessionWorkbenchPreset,
        saveWorkbenchPresetFromSession,
        togglePin,
        setRenamingId,
        setRenameValue,
        canOpenSessionReplay,
        handleOpenSessionReplay,
        unarchiveSession,
        archiveSession,
        softDelete,
        saveExportToDownloads,
        showToast,
        openRuntimeLogsFolder,
        t,
      }),
    [
      applySessionWorkbenchPreset,
      applyWorkbenchPreset,
      applyWorkbenchRecipe,
      archiveSession,
      pinnedSessionIds,
      savedWorkbenchPresets,
      savedWorkbenchRecipes,
      setWorkingDirectory,
      saveWorkbenchPresetFromSession,
      saveExportToDownloads,
      canOpenSessionReplay,
      handleOpenSessionReplay,
      openRuntimeLogsFolder,
      showToast,
      softDelete,
      togglePin,
      unarchiveSession,
      t,
    ],
  );

  const hasAnySessions = sessions.length > 0;
  const hasActiveTrajectoryFilter =
    trajectoryTierFilter !== 'all' || trajectoryFailureFilter !== 'all' || trajectoryReviewFilter !== 'all';
  const hasSearchFilters = Boolean(searchQuery.trim()) || sessionStatusFilter !== 'all' || hasActiveTrajectoryFilter;
  const canSearchCurrentProject = currentProjectSearchSessionIds.size > 0;
  const activeTrajectoryFilterLabel = [
    trajectoryTierFilter !== 'all' ? trajectoryTierFilter : null,
    trajectoryReviewFilter !== 'all' ? buildTrajectoryReviewFilterLabels(t)[trajectoryReviewFilter] : null,
    trajectoryFailureFilter !== 'all'
      ? (buildTrajectoryFailureFilterOptions(t).find((option) => option.id === trajectoryFailureFilter)?.label ??
        trajectoryFailureFilter)
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const activeStatusFilterLabel = [
    buildSessionStatusFilterLabels(t)[sessionStatusFilter] ?? sb.statusMatchFallback,
    activeTrajectoryFilterLabel || null,
  ]
    .filter(Boolean)
    .join(' · ');
  const hasActiveStatusDropdownFilter = sessionStatusFilter !== 'all' || hasActiveTrajectoryFilter;
  const visibleStatusFilterOptions = buildSessionStatusFilterOptions(t).filter(
    (option) => !option.adminOnly || canOpenSessionReplay,
  );
  const showOptionalUpdateButton = isOptionalUpdateAvailable(optionalUpdateInfo);
  const optionalUpdateLabel = optionalUpdateInfo?.latestVersion ? `v${optionalUpdateInfo.latestVersion}` : sb.newVersion;
  const handleUpdateTrajectoryCollection = useCallback(
    async (datasetRole: AgentTrajectoryDatasetRole): Promise<void> => {
      if (!replayDialog) return;
      try {
        const summary = (await ipcService.invoke(IPC_CHANNELS.REPLAY_UPDATE_TRAJECTORY_COLLECTION, {
          sessionId: replayDialog.sessionId,
          patch: { datasetRole },
        })) as AgentTrajectorySessionQualitySummary;
        mergeTrajectoryQualitySummary(replayDialog.sessionId, summary);
        showToast('success', sb.markedAsDataset.replace('{role}', datasetRole));
      } catch (error) {
        logger.warn('Failed to update trajectory collection metadata', {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        showToast('error', sb.updateDatasetFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
      }
    },
    [mergeTrajectoryQualitySummary, replayDialog, showToast],
  );
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
          lastActiveLabel: formatRelativeTime(t, latestActivityAt),
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

  const sessionItemProps: SidebarSessionItemSharedProps = {
    unreadSessionIds,
    automationSummariesBySessionId,
    currentSessionId,
    selectedSessionIds,
    pinnedSessionIds,
    renamingId,
    sessionRuntimes,
    backgroundSessionMap,
    sessionStates,
    hasNeedsInputForSession,
    searchQuery,
    messageSearchHitsBySessionId,
    replayEvidenceBySessionId,
    canOpenSessionReplay,
    reviewItemsBySessionId,
    trajectoryQualityBySessionId,
    multiSelectMode,
    hoveredSession,
    renameValue,
    renameInputRef,
    setHoveredSession,
    setRenameValue,
    handleSelectSession,
    handleContextMenu,
    handleRenameSubmit,
    handleRenameKeyDown,
    handleDoubleClick,
    handleOpenSessionReplay,
    handleOpenSessionAssets,
    handleOpenReplayEvidence,
    handleSelectMessageSearchHit,
    handleArchiveSession,
  };

  const closeSearchDialog = () => {
    setSearchDialogOpen(false);
    setSearchQuery('');
  };

  const handleSelectSearchSession = async (sessionId: string) => {
    try {
      if (sessionId !== currentSessionId) {
        await switchSession(sessionId);
      }
    } finally {
      closeSearchDialog();
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-transparent overflow-hidden">
      {/* Header: h-12 to align with TitleBar on the right */}
      <div className="h-12 px-3 flex items-center justify-between gap-2 flex-shrink-0">
        <NeoBrandMark />
        <div className="flex items-center gap-1">
          <IconButton
            type="button"
            variant="ghost"
            size="md"
            // 与右侧筛选钮尺寸对齐：筛选是 h-8 w-8 容器 + h-4 w-4 图标。lucide 图标自带
            // width/height=24 属性，只靠 IconButton 外层 span 的 w-4 h-4 收不住（会撑破），
            // 必须显式给图标本身 h-4 w-4。
            className="h-8 w-8"
            icon={<Search className="h-4 w-4" />}
            aria-label={sb.openSearch}
            data-testid="sidebar-search-trigger"
            onClick={() => {
              setSearchQuery('');
              setSearchDialogOpen(true);
            }}
          />
          {/* 状态筛选：仅管理员可见；搜索入口对所有人可见。 */}
          {canOpenSessionReplay && (
            <SidebarStatusFilterDropdown
              statusFilterOpen={statusFilterOpen}
              setStatusFilterOpen={setStatusFilterOpen}
              statusFilterRef={statusFilterRef}
              visibleStatusFilterOptions={visibleStatusFilterOptions}
              sessionStatusFilter={sessionStatusFilter}
              setSessionStatusFilter={setSessionStatusFilter}
              trajectoryTierFilter={trajectoryTierFilter}
              setTrajectoryTierFilter={setTrajectoryTierFilter}
              trajectoryFailureFilter={trajectoryFailureFilter}
              setTrajectoryFailureFilter={setTrajectoryFailureFilter}
              trajectoryReviewFilter={trajectoryReviewFilter}
              setTrajectoryReviewFilter={setTrajectoryReviewFilter}
              hasActiveTrajectoryFilter={hasActiveTrajectoryFilter}
              hasActiveStatusDropdownFilter={hasActiveStatusDropdownFilter}
              activeStatusFilterLabel={activeStatusFilterLabel}
            />
          )}
        </div>
      </div>

      {/* 新任务默认纯对话，不继承项目上下文（项目会话走各项目组 + 按钮）。 */}
      <div className="px-2 pb-1 flex-shrink-0">
        <SidebarNewTaskRow
          onClick={handleNewChat}
          disabled={isCreatingSession || creatingWorkspaceKey !== null}
          loading={creatingSessionMode === 'current'}
        />
      </div>

      {/* 能力区：自动化 / 专家 / 资料库（三件套，逐批点亮） */}
      <SidebarCapabilityZone />

      {/* Session List - Project Grouped */}
      <div className="flex-1 overflow-y-auto px-2 min-h-0">
        {isLoading && sessions.length === 0 ? (
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
        ) : filteredSessions.length === 0 && hasSearchFilters ? (
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
            {workspaceGroupedSessions.map((group) => (
              <SidebarProjectGroup
                key={group.key}
                group={group}
                projectMetaById={projectMetaById}
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

      {/* 多选模式底部操作栏 */}
      {multiSelectMode && selectedSessionIds.size > 0 && (
        <div className="px-3 py-2 border-t border-zinc-700 flex items-center justify-between">
          <span className="text-xs text-zinc-400">{sb.selectedCount.replace('{count}', String(selectedSessionIds.size))}</span>
          <div className="flex items-center gap-2">
            <button onClick={clearSelection} className="text-xs text-zinc-500 hover:text-zinc-400 transition-colors">
              {sb.cancel}
            </button>
            <button
              onClick={batchDelete}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {sb.delete}
            </button>
          </div>
        </div>
      )}

      {/* Optional update entry */}
      {showOptionalUpdateButton && (
        <div className="px-2 pb-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => setShowOptionalUpdateModal(true)}
            aria-label={sb.viewUpdateContent.replace('{version}', optionalUpdateLabel)}
            title={sb.viewUpdateContent.replace('{version}', optionalUpdateLabel)}
            className="group flex w-full items-center gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-200 transition-colors hover:border-indigo-400/30 hover:bg-indigo-500/15 hover:text-indigo-100 focus:outline-hidden"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-indigo-500/15 text-indigo-300 group-hover:text-indigo-200">
              <Download className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-left font-medium">{sb.updateAvailable}</span>
            <span className="shrink-0 font-mono text-[11px] text-indigo-300/80">{optionalUpdateLabel}</span>
          </button>
        </div>
      )}

      {/* Bottom: User Menu or Login */}
      <div className="p-2 relative flex-shrink-0" ref={accountMenuRef}>
        {isAuthenticated && user ? (
          <>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              aria-label={sb.userMenu}
              aria-expanded={showUserMenu}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.04] transition-colors"
            >
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover" />
              ) : (
                <User className="w-5 h-5 text-zinc-500" />
              )}
              <span className="flex-1 text-left text-sm font-medium text-zinc-400 truncate">
                {user.nickname || user.email?.split('@')[0]}
              </span>
              {isVerifiedAdmin ? (
                <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                  {sb.adminBadge}
                </span>
              ) : isAdminPendingVerification ? (
                <span
                  className="shrink-0 rounded border border-zinc-500/30 bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300"
                  title={adminPendingTitle}
                >
                  {sb.adminPendingBadge}
                </span>
              ) : null}
              <ChevronDown
                className={`w-4 h-4 text-zinc-600 transition-transform ${showUserMenu ? 'rotate-180' : ''}`}
              />
            </button>
            {/* User Dropdown Menu */}
            {showUserMenu && (
              <div className="absolute bottom-full left-2 right-2 z-50 max-h-[80vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
                <AccountMenuLabel>{sb.menuCommon}</AccountMenuLabel>
                <AccountMenuItem
                  onClick={() => {
                    setShowActivityPanel(true);
                    setShowUserMenu(false);
                  }}
                  icon={<Activity className={`w-4 h-4 ${showActivityPanel ? 'text-cyan-400' : 'text-cyan-400/80'}`} />}
                  label={sb.menuActivity}
                />
                <AccountMenuItem
                  onClick={() => {
                    setShowKnowledgeMemoryPanel(true);
                    setShowUserMenu(false);
                  }}
                  icon={
                    <Brain
                      className={`w-4 h-4 ${showKnowledgeMemoryPanel ? 'text-emerald-400' : 'text-emerald-400/80'}`}
                    />
                  }
                  label={sb.menuKnowledgeMemory}
                />
                <AccountMenuItem
                  onClick={() => {
                    setShowComputerUsePanel(true);
                    setShowUserMenu(false);
                  }}
                  icon={
                    <MousePointerClick
                      className={`w-4 h-4 ${showComputerUsePanel ? 'text-cyan-400' : 'text-cyan-400/80'}`}
                    />
                  }
                  label={sb.menuComputerUse}
                />
                <AccountMenuItem
                  onClick={() => {
                    openProjectCollaborationPage(currentSessionProjectId);
                    setShowUserMenu(false);
                  }}
                  icon={
                    <UsersRound
                      className={`w-4 h-4 ${showProjectCollaborationPage ? 'text-violet-400' : 'text-violet-400/80'}`}
                    />
                  }
                  label={sb.menuNeoCollab}
                />
                <AccountMenuItem
                  onClick={() => {
                    setShowCronCenter(!showCronCenter);
                    setShowUserMenu(false);
                  }}
                  icon={<Clock3 className={`w-4 h-4 ${showCronCenter ? 'text-amber-400' : 'text-amber-400/80'}`} />}
                  label={sb.menuAutomation}
                />
                {canOpenPromptManager && (
                  <AccountMenuItem
                    onClick={() => {
                      setShowPromptManager(true);
                      setShowUserMenu(false);
                    }}
                    icon={<ScrollText className="w-4 h-4 text-violet-400/80" />}
                    label={sb.menuPrompts}
                  />
                )}
                {canOpenUserDashboard && (
                  <AccountMenuItem
                    onClick={() => {
                      openSettingsTab('users');
                      setShowUserMenu(false);
                    }}
                    icon={<Users className="w-4 h-4 text-amber-400/80" />}
                    label={sb.menuUserManagement}
                  />
                )}
                {canOpenInviteCodes && (
                  <AccountMenuItem
                    onClick={() => {
                      openSettingsTab('invites');
                      setShowUserMenu(false);
                    }}
                    icon={<Ticket className="w-4 h-4 text-amber-400/80" />}
                    label={sb.menuInviteCodes}
                  />
                )}

                <div className="my-1 border-t border-zinc-800" />
                <button
                  type="button"
                  onClick={() => setShowAccountAdvancedTools((open) => !open)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 transition-transform ${advancedToolsOpen ? 'rotate-90' : ''}`}
                  />
                  <span className="min-w-0 flex-1 text-left">{sb.advancedTools}</span>
                  {hasActiveAdvancedTool && (
                    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                      {sb.advancedToolsRunning}
                    </span>
                  )}
                </button>
                {advancedToolsOpen && (
                  <div className="pb-1">
                    <AccountMenuItem
                      onClick={() => { setShowLab(true); setShowUserMenu(false); }}
                      icon={<FlaskConical className={`w-4 h-4 ${showLab ? 'text-emerald-400' : 'text-emerald-400/80'}`} />}
                      label={sb.menuModelTraining}
                    />
                    <AccountMenuItem
                      onClick={() => { setShowTimeCapabilityCenter(!showTimeCapabilityCenter); setShowUserMenu(false); }}
                      icon={<CalendarDays className={`w-4 h-4 ${showTimeCapabilityCenter ? 'text-sky-400' : 'text-sky-400/80'}`} />}
                      label={sb.menuTimeCapability}
                    />
                    <AccountMenuItem
                      onClick={() => { setShowDesktopPanel(!showDesktopPanel); setShowUserMenu(false); }}
                      icon={<Monitor className={`w-4 h-4 ${showDesktopPanel ? 'text-cyan-400' : 'text-cyan-400/80'}`} />}
                      label={sb.menuDesktopCapture}
                    />
                    <AccountMenuItem
                      onClick={() => { setShowBrowserSurfacePanel(true); setShowUserMenu(false); }}
                      icon={<Globe className={`w-4 h-4 ${showBrowserSurfacePanel ? 'text-sky-400' : 'text-sky-400/80'}`} />}
                      label={sb.menuBrowser}
                    />
                  </div>
                )}

                <div className="border-t border-zinc-800" />
                <AccountMenuItem
                  onClick={() => {
                    setShowSettings(true);
                    setShowUserMenu(false);
                  }}
                  icon={<Settings className="w-4 h-4" />}
                  label={sb.menuSettings}
                />
                <AccountMenuItem
                  onClick={() => {
                    signOut();
                    setShowUserMenu(false);
                  }}
                  icon={<LogOut className="w-4 h-4" />}
                  label={sb.menuSignOut}
                />
              </div>
            )}
          </>
        ) : (
          <button
            onClick={() => setShowAuthModal(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.08] border border-white/[0.06] text-zinc-400 text-sm font-medium transition-colors"
          >
            <LogIn className="w-4 h-4" />
            {sb.signIn}
          </button>
        )}
      </div>

      <SidebarSearchDialog
        isOpen={searchDialogOpen}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        onClose={closeSearchDialog}
        sessions={searchResultSessions}
        currentSessionId={currentSessionId}
        messageSearchHitsBySessionId={messageSearchHitsBySessionId}
        messageSearchLoading={messageSearchLoading}
        effectiveSearchScope={effectiveSearchScope}
        setSearchScope={setSearchScope}
        canSearchCurrentProject={canSearchCurrentProject}
        onSelectSession={handleSelectSearchSession}
      />

      {/* Replay 摘要 */}
      {replayDialog && (
        <SessionReplaySummaryDialog
          sessionTitle={replayDialog.sessionTitle}
          replay={replayDialog.replay}
          workflowRuns={Object.values(workflowRuns).filter((run) => run.sessionId === replayDialog.sessionId)}
          backgroundTasks={durableBackgroundTasks.filter((task) => task.sessionId === replayDialog.sessionId)}
          evidence={replayEvidenceBySessionId.get(replayDialog.sessionId) ?? []}
          trajectorySummary={trajectoryQualityBySessionId[replayDialog.sessionId]}
          onUpdateTrajectoryDatasetRole={handleUpdateTrajectoryCollection}
          onOpenEvidence={(evidence) => {
            const session = sessions.find((item) => item.id === replayDialog.sessionId);
            if (session) {
              void handleOpenReplayEvidence(session, evidence);
            }
          }}
          onClose={() => setReplayDialog(null)}
        />
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.session)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 撤销删除 Toast */}
      {pendingDelete && (
        <UndoToast
          message={sb.deletedCount.replace('{count}', String(pendingDelete.ids.length))}
          onUndo={undoDelete}
          onDismiss={() => {
            // timer 已经在 softDelete 中设置了，这里是视觉消失后的回调
            // 不需要额外操作，confirmDelete 由 timer 触发
          }}
        />
      )}
    </div>
  );
};
