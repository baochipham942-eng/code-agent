 
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
  LogIn,
  ChevronDown,
  Trash2,
  Search,
  PanelLeftClose,
  Download,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { getCurrentKeybindingPlatform } from '@shared/keybindings/defaults';
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
import { NeoBrandMark } from './features/sidebar/NeoBrandMark';
import { isTauriMode } from '../utils/platform';
import { isNativeWindowFullscreen } from '../services/tauriPluginFacade';
import { useI18n } from '../hooks/useI18n';
import { localeForLanguage } from '../utils/i18nTime';
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
import { SidebarAccountMenu } from './features/sidebar/SidebarAccountMenu';
import { SidebarSearchDialog } from './features/sidebar/SidebarSearchDialog';
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
  const { t, language } = useI18n();
  // 原生标题栏撤掉后 macOS 红绿灯浮在侧栏头行左端，得给它留死区（Windows/Linux 无此约束）。
  // 红绿灯只存在于「Tauri 壳 + macOS + 非全屏」：全屏时系统把它藏起来，浏览器里根本没有——
  // 这两种态左上角空着难看，改挂品牌标（2026-07-27 产品负责人拍板）。
  const isMacShell = getCurrentKeybindingPlatform() === 'darwin';
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);
  useEffect(() => {
    if (!isTauriMode()) return;
    let alive = true;
    const check = () => {
      isNativeWindowFullscreen()
        .then((v) => { if (alive) setIsNativeFullscreen(v); })
        .catch(() => {});
    };
    check();
    window.addEventListener('resize', check);
    return () => { alive = false; window.removeEventListener('resize', check); };
  }, []);
  const trafficLightZone = isMacShell && isTauriMode() && !isNativeFullscreen;
  const sb = t.sidebar;
  const {
    clearPlanningState,
    setWorkingDirectory,
    showLab,
    showTimeCapabilityCenter,
    showDesktopPanel,
    optionalUpdateInfo,
    setShowOptionalUpdateModal,
    openWorkspacePreview,
    setSidebarCollapsed,
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
    isLoading: isAuthLoading,
    setShowAuthModal,
    sessionTrustState,
    authBackendAvailable,
    hasCachedAdminClaim,
  } = useAuthStore();
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
    showLab || showTimeCapabilityCenter || showDesktopPanel,
  );
  const advancedToolsOpen = showAccountAdvancedTools || hasActiveAdvancedTool;

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
    handleOpenSessionReplayInEvalCenter,
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
    handleOpenSessionReplayInEvalCenter,
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
    // 侧栏横向节奏的单一真源（2026-07-27 产品负责人：「内容都太靠左，而且左右 padding 不一样」）：
    //   根左右各让一条 --scrollbar-size 的带 → 右边那条给滚动条用（列表用等宽负 margin 要回去），
    //   左边那条是纯留白，于是**外框左右等宽**；各区块统一 px-1(4)，各行内统一 px-1.5(6)。
    //   ⇒ 任意行的内容左缘 16 / 右缘 224，四边 padding 全等 16。
    //   为什么是 16 而不是别的数：顶行元素在栏内垂直居中 ⇒ 栏高 = 2×padding + 图标框 16。
    //   padding 26 会把顶栏顶成 68 高（2026-07-28 产品负责人：「标题栏长那么高？」并给了
    //   Codex 对照——它是 11/14）。16 是唯一让栏高回到 48(h-12) 的取值，四边又同时相等。
    //   ⚠️ 早先修左右不对称时选错了方向：把左边推到 26 去迁就被 pr-3+滚动条带撑大的右边；
    //   正解是把右边收回来。padding 一改，栏高、灯的 x/y、收起态让位、overlay 让位全要跟着算。
    // 改这里的任何一个数，下面每一处（入口区 / 分组头 / 会话行 / 账号行 / 顶行图标）都要跟着对，
    // 否则又会退回改之前那种「三条右轨、两条左轨」的状态。
    <div className="flex-1 flex flex-col bg-transparent overflow-hidden px-[var(--scrollbar-size)]">
      {/* Header: h-12 to align with TitleBar on the right.
          2026-07-27 审美关：① 原生标题栏已撤（tauri.conf.json titleBarStyle=Overlay +
          hiddenTitle），内容延伸到窗口顶，macOS 红绿灯浮在本行左端；灯的横纵都由原生 objc 摆
          （src-tauri/src/traffic_lights.rs：左缘 16、中心 24），与本行图标同轴、同左轨。
          ② 图标在本行**垂直居中**（h-12 ⇒ 图标框中心 24），与右侧 TitleBar 的图标同一水平——
          两条顶栏的控件必须同轴（2026-07-27 拍板）。行高 48 + 图标框 16 居中 ⇒ 上下 padding 各 16，
          与左右 16 齐（2026-07-28：「红绿灯上面的 padding = 左边的 padding」）。
          ⚠️ 对齐口径是布局框不是可见笔画：每个 lucide 图标在自己 16px 框里的内缩都不同
          （实测开关字形右边空 3、箭头空 5、角标空 1.5），按笔画永远拉不齐，按框才能一致。
          ③ 功能图标**右对齐**（07-27 二次拍板）：最右那颗落在分组角标 / 状态点 / 账号箭头
          那条右轨（字形框右缘 224）上。
          ⚠️ 本行的 px 比别处小 8：这里的图标是 32px 的 IconButton（16 字形居中 ⇒ 框内自带 8 内缩），
          而角标 / 状态点 / 箭头都是裸 16px 字形。喂同一个 px 值，前者会比后者多缩 8、右轨断开
          （2026-07-28 实测中心 206.8 vs 214.8）。所以这里写 px-0.5，让**字形框**而不是按钮框对齐。
          ④ 左槽：红绿灯不在场时（全屏 / 浏览器 / 非 mac 壳）挂品牌标，否则留空让位给灯
          （批 C2 增量）；品牌标自己补 pl-2 落到 16 左轨上。
          本行同时是窗口拖拽区（原生标题栏没了，得自己给一块能拖的地方）。
          ⚠️ 拖拽靠 `data-tauri-drag-region` 属性——`-webkit-app-region: drag` 是 Electron 的
          私有属性，Tauri 的 WKWebView 根本不认，只写 style 的话窗口拖不动、双击也不缩放
          （2026-07-27 产品负责人实测「双击标题栏没反应」）。style 保留是给 web/Electron 兜底。 */}
      <div
        data-tauri-drag-region
        className="h-12 flex items-center justify-between gap-2 flex-shrink-0 px-0.5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* 左槽：红绿灯在场时留空（灯自己占位），否则挂品牌标 */}
        <div className="flex min-w-0 items-center pl-2">
          {!trafficLightZone && <NeoBrandMark size={22} />}
        </div>
        {/* 图标之间不留 gap：32px 按钮首尾相接 ⇒ 中心间距 32，与 Codex 顶栏一致 */}
        <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>          {!isAuthLoading && (
            <>
            <IconButton
              type="button"
              variant="ghost"
              size="md"
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
            </>
          )}
          {/* 侧栏收起开关坐在侧栏自己头上（2026-07-27 审美关拍板：从右侧顶栏挪回左侧面板）。
              收起态的展开入口留在 TitleBar——侧栏那时不存在，按钮得有别的落脚点。 */}
          <IconButton
            icon={<PanelLeftClose className="h-4 w-4" />}
            aria-label={sb.collapseSidebar}
            data-testid="sidebar-collapse"
            onClick={() => setSidebarCollapsed(true)}
            variant="ghost"
            size="md"
            className="h-8 w-8"
          />
        </div>
      </div>

      {/* 「选择目录」行已退役（批C2）：目录选择并入新任务流程（欢迎页目录 chip +
          DirectoryPickerModal/原生选择器），侧栏不再展示内部路径。 */}

      {/* 新任务默认纯对话，不继承项目上下文（项目会话走各项目组 + 按钮）。
          与能力区之间零间距：四条入口行等距同组，区间断点只留在能力区之后（pb-2）。 */}
      <div className="px-1 flex-shrink-0">
        <SidebarNewTaskRow
          onClick={handleNewChat}
          disabled={isCreatingSession || creatingWorkspaceKey !== null}
          loading={creatingSessionMode === 'current'}
        />
      </div>

      {/* 能力区：自动化 / 专家 / 资料库（三件套，逐批点亮） */}
      <SidebarCapabilityZone />

      {/* Session List - Project Grouped
          scrollbar-hidden 不是审美选择，是右轨对齐的根因修复（2026-07-27 实测）：
          global.css 给了 `::-webkit-scrollbar{width:6px}` 这种**占布局宽度**的经典滚动条，
          列表一溢出，容器内容盒就窄 6px ⇒ 组角标/状态点中心被推到 205.8，
          而账号行在滚动容器**外**、中心仍是 212，三者于是不同轴（产品负责人 07-27 反馈）。
          按状态补 6px padding 只在"正在溢出"时对，不溢出时反而错——只有把这段占位彻底去掉，
          栏内所有行才共用同一条右轨（220 右缘 / 212 中心），与溢出与否无关。
          做法（参照 Codex：滚动条独占最右一条窄带，内容轨不受它影响）：侧栏根 `pr` 让出
          一条滚动条宽的窄带 ⇒ 顶行/能力区/账号行都缩到同一条内轨；本滚动容器再用等宽负 margin
          把那条窄带"要回来"，`overflow-y-scroll` 恒定占位把滚动条正好摆进去 ⇒ 它的内容盒宽度
          回到与兄弟块相同的内轨。滚动条照常可见，且与列表溢不溢出无关。 */}
      <div className="flex-1 overflow-y-scroll px-1 min-h-0 mr-[calc(var(--scrollbar-size)*-1)]" data-testid="sidebar-session-scroll">
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
        <div className="px-1 pb-1 flex-shrink-0">
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
      {/* 上下留白按「与顶行对称」反推，不是拍脑袋：顶行 h-12(48) 内容居中 ⇒ 图标框中心距顶 24。
          底部这块也做成 48 高：容器 py-1.5(6) + 行 py-2(8)*2 + 行内容 20(text-sm leading-5) = 48
          ⇒ 内容中心距底 6+18 = 24，图标框下缘距底 16，与左右各 16 齐。
          注意行内容高由**最高的那个**决定（昵称 text-sm 的 20，不是头像的 16）——
          按 16 算会差 2px，实测才发现（2026-07-28）。横向仍是 4，与其他区块 px-1 同规范。 */}
      <div className="px-1 py-1.5 relative flex-shrink-0" ref={accountMenuRef}>
        {isAuthenticated && user ? (
          <>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              aria-label={sb.userMenu}
              aria-expanded={showUserMenu}
              /* 落到全侧栏基准轨（数值见 Sidebar 根的横向节奏注释）：
                 根带 6 + 容器 p-2(8) + 行 px-3(12) = 图标左缘 26；+图标 16 +gap-2.5(10) = 昵称左缘 52，
                 与入口行/分组名/会话行标题同线；右侧同样 6+8+12 ⇒ 内容右缘 214，
                 展开箭头与分组头角标/会话行状态点同轴。左右内边距都用 px-3，不再一边 8 一边 12。 */
              className="w-full flex items-center gap-2.5 px-1.5 py-2 rounded-xl hover:bg-white/[0.04] transition-colors"
            >
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="w-4 h-4 shrink-0 rounded-full object-cover" />
              ) : (
                <User className="w-4 h-4 shrink-0 text-zinc-500" />
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
            {/* User Dropdown Menu（整块已抽成 SidebarAccountMenu：Sidebar 逼近 god-file 门） */}
            {showUserMenu && (
              <SidebarAccountMenu
                onClose={() => setShowUserMenu(false)}
                advancedToolsOpen={advancedToolsOpen}
                onToggleAdvancedTools={() => setShowAccountAdvancedTools((open) => !open)}
                hasActiveAdvancedTool={hasActiveAdvancedTool}
              />
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
