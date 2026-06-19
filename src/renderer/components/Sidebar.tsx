/* eslint-disable max-lines -- 既有超限文件（接入「桌面操作」入口前已 ~1005 行 > 1000），拆分另议 */
// ============================================================================
// Sidebar - Linear-style session list with grouped cards and session management
// ============================================================================

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSessionStore, initializeSessionStore, type SessionWithMeta } from '../stores/sessionStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useSessionUIStore, type SessionStatusFilter } from '../stores/sessionUIStore';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { useWorkbenchPresetStore } from '../stores/workbenchPresetStore';
import { useAuthStore } from '../stores/authStore';
import { useTaskStore } from '../stores/taskStore';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useWorkflowStore } from '../stores/workflowStore';
import {
  MessageSquare,
  Plus,
  Archive,
  ArchiveRestore,
  Loader2,
  User,
  Settings,
  LogIn,
  LogOut,
  ChevronDown,
  CheckSquare,
  Square,
  Trash2,
  Pin,
  Search,
  X,
  Folder,
  MessageSquareText,
  ChevronRight,
  FlaskConical,
  Clock3,
  CalendarDays,
  Monitor,
  MousePointerClick,
  ScrollText,
  Activity,
  Brain,
  Users,
  Ticket,
  Download,
  ListChecks,
  Eye,
  ShieldAlert,
  PanelRightOpen,
  ListFilter,
  Check,
} from 'lucide-react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import type { ConfigScopeSummary } from '@shared/contract/configScope';
import { useUIStore } from '../stores/uiStore';
import { IconButton, UndoToast } from './primitives';
import { createLogger } from '../utils/logger';
import { isWorkspaceExpanded } from '../utils/workspaceGrouping';
import {
  buildSidebarProjectSummary,
  formatSidebarProjectSummaryLine,
} from '../utils/sidebarProjectSummary';
import { SessionContextMenu, type ContextMenuItem } from './features/sidebar/SessionContextMenu';
import { SidebarProjectDetail } from './features/sidebar/SidebarProjectDetail';
import { SidebarProjectDrawer, type SidebarProjectDrawerSession } from './features/sidebar/SidebarProjectDrawer';
import { SidebarMessageHitList } from './features/sidebar/SidebarMessageHitList';
import { SessionReplaySummaryDialog } from './features/sidebar/SessionReplaySummaryDialog';
import { getSessionTypeLabel } from './features/sidebar/SessionTypeFilterBar';
import {
  AccountMenuItem,
  AccountMenuLabel,
  canReuseSessionWorkbench,
  getRelativeTime,
} from './features/sidebar/sidebarPresentation';
import ipcService from '../services/ipcService';
import {
  getDisplaySessionTitle,
  getSessionStatusPresentation,
} from '../utils/sessionPresentation';
import { buildSessionRecoveryHints, hasSessionDeliverySignals } from '../utils/sessionRecoveryHints';
import {
  resolveSidebarGroupExpansionView,
} from '../utils/sidebarGroupExpansion';
import {
  formatSidebarMessageSearchHitLabel,
  formatSidebarMessageSearchHitMeta,
} from '../utils/sidebarMessageSearch';
import { type SessionReplayEvidence } from '../utils/sessionReplayEvidence';
import { openSessionReplayEvidenceTarget } from '../utils/openSessionReplayEvidence';
import { copyPathToClipboard, openExternalLink } from '../utils/platform';
import { isOptionalUpdateAvailable } from '../utils/updatePrompt';
import { canAccessFeature } from '../utils/accessControl';
import { buildSessionContextMenuItems } from './features/sidebar/sessionContextMenuItems';
import { useSidebarDerivedSessions } from './features/sidebar/useSidebarDerivedSessions';
import { useSidebarSessionActions } from './features/sidebar/useSidebarSessionActions';
import type { StructuredReplay } from '@shared/contract/evaluation';

const logger = createLogger('Sidebar');
const SESSION_STATUS_FILTER_OPTIONS: Array<{ id: SessionStatusFilter; label: string; adminOnly?: boolean }> = [
  { id: 'all', label: '全部' },
  { id: 'unfinished', label: '未完成' },
  { id: 'approval', label: '待确认' },
  { id: 'running', label: '执行中' },
  { id: 'attention', label: '需关注' },
  { id: 'artifact', label: '交付线索' },
  { id: 'review', label: '待审', adminOnly: true },
];
const SESSION_STATUS_FILTER_LABELS: Record<SessionStatusFilter, string> = {
  all: '全部',
  unfinished: '未完成',
  approval: '待确认',
  running: '执行中',
  attention: '需关注',
  artifact: '交付线索',
  review: '待审',
  background: '后台执行中',
};

function formatReplayEvidenceOverflowTitle(evidence: SessionReplayEvidence[]): string {
  return evidence
    .slice(2)
    .map((item) => `${item.type === 'trace' ? 'Trace' : 'Replay'} · ${item.label}`)
    .join('\n');
}

function formatReplayEvidenceButtonTitle(
  evidence: SessionReplayEvidence,
  canOpenSessionReplay: boolean,
): string {
  if (evidence.actionKind !== 'sessionReplay' || canOpenSessionReplay) {
    return evidence.title;
  }
  return `${evidence.title}\n结构化 Replay 仅管理员可打开`;
}

function dirname(filePath: string): string | null {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (index <= 0) return null;
  return filePath.slice(0, index);
}

function joinChildPath(basePath: string, childName: string): string {
  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/';
  return `${basePath.replace(/[\\/]+$/, '')}${separator}${childName}`;
}

export function resolveRuntimeLogsDir(configScope: ConfigScopeSummary | null | undefined): string | null {
  const runtimeLayer = configScope?.layers.find((layer) => layer.id === 'runtime');
  const runtimeFilePath = runtimeLayer?.items.find((item) => item.id === 'runtime-app-settings')?.path
    ?? runtimeLayer?.items.find((item) => item.id === 'runtime-db')?.path;
  if (!runtimeFilePath || runtimeFilePath === 'app bundle') return null;
  const runtimeDir = dirname(runtimeFilePath);
  return runtimeDir ? joinChildPath(runtimeDir, 'logs') : null;
}

export function isAccountMenuEventOutside(
  accountMenuElement: { contains: (node: Node) => boolean } | null,
  target: EventTarget | null,
): boolean {
  if (!accountMenuElement || !target) return false;
  return !accountMenuElement.contains(target as Node);
}

export const Sidebar: React.FC = () => {
  const {
    clearPlanningState,
    setShowSettings,
    openSettingsTab,
    setShowPromptManager,
    setWorkingDirectory,
    showLab,
    setShowLab,
    showCronCenter,
    setShowCronCenter,
    showTimeCapabilityCenter,
    setShowTimeCapabilityCenter,
    showDesktopPanel,
    setShowDesktopPanel,
    showActivityPanel,
    setShowActivityPanel,
    showKnowledgeMemoryPanel,
    setShowKnowledgeMemoryPanel,
    showComputerUsePanel,
    setShowComputerUsePanel,
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
  const isAdminPendingVerification = !isVerifiedAdmin
    && hasCachedAdminClaim
    && sessionTrustState === 'cached';
  const adminPendingTitle = authBackendAvailable === false
    ? '登录服务启动失败，管理员身份暂时不能验证'
    : '正在验证管理员身份';
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
    showLab ||
      showTimeCapabilityCenter ||
      showDesktopPanel
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

  // 重命名 input 聚焦
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const {
    backgroundTaskMap,
    replayEvidenceBySessionId,
    hasPendingApprovalForSession,
    currentProjectSearchSessionIds,
    effectiveSearchScope,
    setSearchScope,
    messageSearchHitsBySessionId,
    messageSearchLoading,
    reviewItemsBySessionId,
    filteredSessions,
    workspaceGroupedSessions,
    projectMetaById,
    setProjectMetaById,
  } = useSidebarDerivedSessions({ canOpenSessionReplay });

  const [expandedProjectDetails, setExpandedProjectDetails] = useState<Record<string, boolean>>({});
  const [projectDrawerKey, setProjectDrawerKey] = useState<string | null>(null);
  const [collapsingWorkspaces, setCollapsingWorkspaces] = useState<Record<string, boolean>>({});
  const collapseTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => () => {
    Object.values(collapseTimersRef.current).forEach(clearTimeout);
    collapseTimersRef.current = {};
  }, []);

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
  });

  // 右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent, session: SessionWithMeta) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, session });
  }, []);

  const showToast = useUIStore((state) => state.showToast);

  // 导出落盘统一走主进程写「下载」文件夹 + 访达定位（webview 另存为对话框在
  // 打包态会静默失败，见 workspace.ipc handleSaveTextToDownloads 注释）
  const saveExportToDownloads = useCallback(async (fileName: string, content: string) => {
    const saved = await window.domainAPI?.invoke<{ filePath: string }>(
      IPC_DOMAINS.WORKSPACE,
      'saveTextToDownloads',
      { fileName, content },
    );
    if (!saved?.success || !saved.data?.filePath) {
      throw new Error(saved?.error?.message || 'Failed to save export');
    }
    showToast('success', `已导出到下载文件夹：${fileName}`);
    void window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'showItemInFolder', {
      filePath: saved.data.filePath,
    });
  }, [showToast]);

  const openRuntimeLogsFolder = useCallback(async (): Promise<boolean> => {
    try {
      const scope = await window.domainAPI?.invoke<ConfigScopeSummary>(
        IPC_DOMAINS.WORKSPACE,
        'getConfigScope',
      );
      if (!scope?.success) {
        throw new Error(scope?.error?.message || 'Failed to resolve app data directory');
      }
      const logsDir = resolveRuntimeLogsDir(scope.data);
      if (!logsDir) {
        throw new Error('Failed to resolve logs directory');
      }
      const opened = await window.domainAPI?.invoke(
        IPC_DOMAINS.WORKSPACE,
        'openPath',
        { filePath: logsDir },
      );
      if (opened && !opened.success) {
        throw new Error(opened.error?.message || 'Failed to open logs directory');
      }
      return true;
    } catch (error) {
      logger.warn('Failed to open runtime logs folder', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }, []);

  const handleOpenSessionReplay = useCallback(async (session: SessionWithMeta) => {
    if (!canOpenSessionReplay) {
      showToast('warning', 'Replay 目前仅管理员可用');
      return;
    }

    try {
      const replay = await ipcService.invoke(IPC_CHANNELS.REPLAY_GET_STRUCTURED_DATA, session.id) as StructuredReplay | null;
      if (!replay) {
        showToast('warning', '当前会话还没有可用 Replay 数据');
        return;
      }
      setReplayDialog({
        sessionId: session.id,
        sessionTitle: getDisplaySessionTitle(session.title),
        replay,
      });
    } catch (error) {
      logger.error('Failed to open session replay', error);
      showToast('error', `打开 Replay 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [canOpenSessionReplay, showToast]);

  const handleOpenReplayEvidence = useCallback(async (
    session: SessionWithMeta,
    evidence: SessionReplayEvidence,
  ) => {
    await openSessionReplayEvidenceTarget(evidence, {
      openSessionReplay: () => handleOpenSessionReplay(session),
      openPath: async (filePath) => {
        const opened = await window.domainAPI?.invoke(
          IPC_DOMAINS.WORKSPACE,
          'openPath',
          { filePath },
        );
        if (opened && !opened.success) {
          throw new Error(opened.error?.message || 'Failed to open evidence file');
        }
      },
      openExternal: openExternalLink,
      copyText: copyPathToClipboard,
      notify: showToast,
    });
  }, [handleOpenSessionReplay, showToast]);

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
    ],
  );

  // 双击开始重命名
  const handleDoubleClick = useCallback((e: React.MouseEvent, session: SessionWithMeta) => {
    e.preventDefault();
    e.stopPropagation();
    setRenamingId(session.id);
    setRenameValue(getDisplaySessionTitle(session.title));
  }, []);

  // 提交重命名
  const handleRenameSubmit = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameSession(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  }, [renamingId, renameValue, renameSession]);

  // 重命名按键
  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setRenamingId(null);
      setRenameValue('');
    }
  }, [handleRenameSubmit]);

  const hasAnySessions = sessions.length > 0;
  const hasSearchFilters = Boolean(searchQuery.trim()) || sessionStatusFilter !== 'all';
  const canSearchCurrentProject = currentProjectSearchSessionIds.size > 0;
  const showSearchScopeControls = Boolean(searchQuery.trim()) && canSearchCurrentProject;
  const activeStatusFilterLabel = SESSION_STATUS_FILTER_LABELS[sessionStatusFilter] ?? '匹配';
  const visibleStatusFilterOptions = SESSION_STATUS_FILTER_OPTIONS
    .filter((option) => !option.adminOnly || canOpenSessionReplay);
  const showOptionalUpdateButton = isOptionalUpdateAvailable(optionalUpdateInfo);
  const optionalUpdateLabel = optionalUpdateInfo?.latestVersion
    ? `v${optionalUpdateInfo.latestVersion}`
    : '新版本';
  const buildProjectDrawerSessions = useCallback((groupSessions: SessionWithMeta[]): SidebarProjectDrawerSession[] => (
    groupSessions.map((session) => {
      const sessionRuntime = sessionRuntimes.get(session.id);
      const backgroundTask = backgroundTaskMap.get(session.id);
      const status = getSessionStatusPresentation({
        backgroundTask,
        runtime: sessionRuntime,
        taskState: sessionStates[session.id],
        messageCount: session.messageCount,
        turnCount: session.turnCount,
        sessionStatus: session.status,
        hasPendingApproval: hasPendingApprovalForSession(session.id),
      });
      const latestActivityAt = Math.max(
        session.updatedAt || 0,
        sessionRuntime?.lastActivityAt || 0,
        backgroundTask?.backgroundedAt || 0,
      );
      const replayEvidenceCount = replayEvidenceBySessionId.get(session.id)?.length ?? 0;
      const pendingReviewCount = (reviewItemsBySessionId[session.id] ?? [])
        .filter((item) => item.reviewStatus === 'pending')
        .length;
      const snapshotSummary = session.workbenchSnapshot?.summary?.trim();
      const hasMeaningfulSummary = Boolean(snapshotSummary && snapshotSummary !== '纯对话');

      return {
        id: session.id,
        title: getDisplaySessionTitle(session.title),
        statusLabel: status.label,
        statusToneClassName: status.toneClassName,
        showStatusBadge: status.showBadge,
        typeLabel: getSessionTypeLabel(session.type),
        summary: hasMeaningfulSummary ? snapshotSummary : undefined,
        lastActiveLabel: getRelativeTime(latestActivityAt, true),
        workingDirectory: session.workingDirectory,
        gitBranch: session.gitBranch,
        prLabel: session.prLink ? `PR #${session.prLink.number}` : undefined,
        isCurrent: session.id === currentSessionId,
        turnCount: session.turnCount,
        messageCount: session.messageCount,
        hasDeliverySignals: hasSessionDeliverySignals(session, { hasReplay: replayEvidenceCount > 0 }),
        replayEvidenceCount,
        pendingReviewCount,
      };
    })
  ), [
    backgroundTaskMap,
    currentSessionId,
    hasPendingApprovalForSession,
    replayEvidenceBySessionId,
    reviewItemsBySessionId,
    sessionRuntimes,
    sessionStates,
  ]);

  // 渲染单个会话项
  const renderSessionItem = (session: SessionWithMeta) => {
    const isUnread = unreadSessionIds.has(session.id);
    const isSelected = currentSessionId === session.id;
    const isChecked = selectedSessionIds.has(session.id);
    const isPinned = pinnedSessionIds.has(session.id);
    const isRenaming = renamingId === session.id;
    const sessionRuntime = sessionRuntimes.get(session.id);
    const backgroundTask = backgroundTaskMap.get(session.id);
    // 空会话（0 轮 / 0 消息）没有可回放内容，行内不展示 Replay 入口，避免「新对话」上挂个没用的图标。
    const sessionHasActivity = (session.turnCount ?? 0) > 0 || (session.messageCount ?? 0) > 0;
    const status = getSessionStatusPresentation({
      backgroundTask,
      runtime: sessionRuntime,
      taskState: sessionStates[session.id],
      messageCount: session.messageCount,
      turnCount: session.turnCount,
      sessionStatus: session.status,
      hasPendingApproval: hasPendingApprovalForSession(session.id),
    });
    const latestActivityAt = Math.max(
      session.updatedAt || 0,
      sessionRuntime?.lastActivityAt || 0,
      backgroundTask?.backgroundedAt || 0,
    );
    const snapshotSummary = session.workbenchSnapshot?.summary?.trim() || '';
    const hasMeaningfulSummary = snapshotSummary && snapshotSummary !== '纯对话';
    const messageSearchHitGroup = searchQuery.trim() ? messageSearchHitsBySessionId[session.id] : undefined;
    const messageSearchHit = messageSearchHitGroup?.bestHit;
    const lastActiveLabel = getRelativeTime(latestActivityAt, true);
    const typeLabel = getSessionTypeLabel(session.type);
    const displayTitle = getDisplaySessionTitle(session.title);
    const canOpenSessionAssets = canReuseSessionWorkbench(session);
    const replayEvidence = replayEvidenceBySessionId.get(session.id) ?? [];
    const hasReplaySignal = replayEvidence.length > 0;
    const recoveryHints = buildSessionRecoveryHints(session, {
      hasReplay: hasReplaySignal,
      canOpenReplay: canOpenSessionReplay,
    });
    const pendingReviewItems = (reviewItemsBySessionId[session.id] ?? [])
      .filter((item) => item.reviewStatus === 'pending');
    const topReviewItem = pendingReviewItems[0];

    return (
      <div
        key={session.id}
        onClick={() => handleSelectSession(session.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void handleSelectSession(session.id);
          }
        }}
        onContextMenu={(e) => handleContextMenu(e, session)}
        onMouseEnter={() => setHoveredSession(session.id)}
        onMouseLeave={() => setHoveredSession(null)}
        role="button"
        tabIndex={0}
        aria-current={isSelected && !multiSelectMode ? 'true' : undefined}
        aria-label={`打开会话 ${displayTitle}`}
        data-session-id={session.id}
        className={`group relative px-3 py-2 rounded-lg cursor-pointer transition-all duration-150 ${
          isSelected && !multiSelectMode
            ? 'bg-zinc-700/60'
            : isChecked
              ? 'bg-blue-500/10 border border-blue-500/20'
              : 'hover:bg-zinc-800'
        }`}
      >
        {/* 多选模式：Checkbox */}
        {multiSelectMode && (
          <div className="flex items-center mb-1">
            {isChecked ? (
              <CheckSquare className="w-4 h-4 text-blue-400" />
            ) : (
              <Square className="w-4 h-4 text-zinc-500" />
            )}
          </div>
        )}

        {/* Line 1: status indicators + title */}
        <div className="flex items-center gap-2">
          {/* 置顶图标 */}
          {isPinned && !multiSelectMode && (
            <Pin className="w-3 h-3 text-amber-500 shrink-0 -rotate-45" />
          )}

          {/* 标题：重命名模式 vs 普通 */}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 text-sm bg-zinc-600/80 text-zinc-200 px-1.5 py-0.5 rounded border border-zinc-600 focus:border-blue-500 focus:outline-hidden"
            />
          ) : (
            <span
              onDoubleClick={(e) => handleDoubleClick(e, session)}
              className={`text-sm truncate font-medium flex-1 ${
                isSelected ? 'text-zinc-100' : 'text-zinc-400'
              }`}
            >
              {displayTitle}
            </span>
          )}

          {!multiSelectMode && !isRenaming && (
            <>
              {/* D-9: Replay 仅管理员可用 — 非管理员直接不渲染；空会话也不渲染（无可回放内容） */}
              {canOpenSessionReplay && sessionHasActivity && (
                <button
                  type="button"
                  aria-label={`打开 ${displayTitle} Replay`}
                  title={`打开 ${displayTitle} Replay`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleOpenSessionReplay(session);
                  }}
                  className="shrink-0 rounded-md p-1 text-zinc-500 opacity-0 transition-all hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden group-hover:opacity-100"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              )}
              {topReviewItem && (
                <button
                  type="button"
                  aria-label={`打开 ${displayTitle} 的 Review 证据`}
                  title={`${pendingReviewItems.length} 个待审 issue · ${topReviewItem.title}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleOpenSessionReplay(session);
                  }}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 transition-colors hover:border-amber-400/30 hover:bg-amber-500/15 hover:text-amber-200 focus:outline-hidden"
                >
                  <ShieldAlert className="h-3 w-3" />
                  <span>{pendingReviewItems.length} 待审</span>
                </button>
              )}
              {canOpenSessionAssets && (
                <button
                  type="button"
                  aria-label={`打开 ${displayTitle} 的产物与资产`}
                  title={`打开 ${displayTitle} 的产物与资产`}
                  onClick={(event) => { void handleOpenSessionAssets(event, session); }}
                  className="shrink-0 rounded-md p-1 text-zinc-500 opacity-0 transition-all hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden group-hover:opacity-100"
                >
                  <ScrollText className="h-3.5 w-3.5" />
                </button>
              )}
              {typeLabel && (
                <span className="shrink-0 rounded-full border border-zinc-700 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 transition-opacity duration-150 group-hover:opacity-0">
                  {typeLabel}
                </span>
              )}
              {status.showBadge && (
                <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium transition-opacity duration-150 group-hover:opacity-0 ${status.toneClassName}`}>
                  {status.label}
                </span>
              )}
            </>
          )}
        </div>

        {/* Line 2: summary + recent activity */}
        {!isRenaming && (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-600">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              {messageSearchHit ? (
                <span className="truncate text-zinc-400">
                  <span className="text-zinc-500">
                    {formatSidebarMessageSearchHitMeta(messageSearchHit)}
                  </span>
                  <span> · {formatSidebarMessageSearchHitLabel(messageSearchHit)}</span>
                </span>
              ) : hasMeaningfulSummary && (
                <span className="truncate text-zinc-500">
                  {snapshotSummary}
                </span>
              )}
              {recoveryHints.map((hint) => (
                <span
                  key={`${session.id}:${hint.kind}:${hint.label}`}
                  title={hint.title}
                  className="shrink-0 rounded border border-zinc-700/60 bg-zinc-900/70 px-1 py-0.5 text-[10px] font-medium text-zinc-500"
                >
                  {hint.label}
                </span>
              ))}
            </span>
            <span className="text-[10px] text-zinc-600 shrink-0">
              {(session.turnCount ?? 0) > 0 ? `${session.turnCount} 轮 · ${lastActiveLabel}` : lastActiveLabel}
            </span>
          </div>
        )}

        {!isRenaming && replayEvidence.length > 0 && (
          <div className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden text-[10px] text-zinc-500">
            {replayEvidence.slice(0, 2).map((evidence) => (
              <button
                key={evidence.id}
                type="button"
                aria-label={canOpenSessionReplay
                  || evidence.actionKind !== 'sessionReplay'
                  ? `打开 ${displayTitle} 的 ${evidence.label}`
                  : `Replay 仅管理员可用：${displayTitle} 的 ${evidence.label}`}
                title={formatReplayEvidenceButtonTitle(evidence, canOpenSessionReplay)}
                disabled={evidence.actionKind === 'sessionReplay' && !canOpenSessionReplay}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void handleOpenReplayEvidence(session, evidence);
                }}
                className="inline-flex min-w-0 shrink items-center gap-1 rounded border border-zinc-700/60 bg-zinc-900/50 px-1.5 py-0.5 text-zinc-500 transition-colors hover:border-zinc-600 hover:bg-zinc-800/80 hover:text-zinc-300 focus:outline-hidden disabled:cursor-not-allowed disabled:hover:border-zinc-700/60 disabled:hover:bg-zinc-900/50 disabled:hover:text-zinc-500"
              >
                <span className="shrink-0 text-zinc-600">
                  {evidence.type === 'trace' ? 'Trace' : 'Replay'}
                </span>
                <span className="truncate">
                  {evidence.label}
                </span>
              </button>
            ))}
            {replayEvidence.length > 2 && (
              <span
                title={formatReplayEvidenceOverflowTitle(replayEvidence)}
                className="shrink-0 rounded border border-zinc-700/60 bg-zinc-900/50 px-1.5 py-0.5 text-zinc-600"
              >
                +{replayEvidence.length - 2}
              </span>
            )}
          </div>
        )}

        {!isRenaming && messageSearchHitGroup && (
          <SidebarMessageHitList
            sessionId={session.id}
            hits={messageSearchHitGroup.hits}
            onSelectHit={handleSelectMessageSearchHit}
          />
        )}

        {/* Hover actions — absolute positioned top-right */}
        {hoveredSession === session.id && !multiSelectMode && !isRenaming && (
          <div className="absolute top-1.5 right-2 flex items-center gap-0.5">
            <IconButton
              icon={session.isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
              aria-label={session.isArchived ? "Unarchive session" : "Archive session"}
              onClick={(e) => handleArchiveSession(session.id, !!session.isArchived, e)}
              variant="ghost"
              size="sm"
              className="!p-1 opacity-0 group-hover:opacity-100"
              title={session.isArchived ? "取消归档" : "归档"}
            />
          </div>
        )}

        {/* 未读指示器 */}
        {isUnread && !multiSelectMode && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 w-2 h-2 bg-purple-500 rounded-full" />
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col bg-transparent overflow-hidden">
      {/* Header: h-12 to align with TitleBar on the right */}
      <div className="h-12 px-3 flex items-center justify-between gap-2 flex-shrink-0 window-drag">
        {/* New Chat — 纯对话，不继承项目上下文（项目会话走各项目组 + 按钮） */}
        <button
          onClick={handleNewChat}
          disabled={isCreatingSession || creatingWorkspaceKey !== null}
          title="新建会话（纯对话，不继承项目上下文）"
          className="flex min-w-0 flex-1 items-center gap-2 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50 window-no-drag"
        >
          <span className="w-6 h-6 rounded-full bg-zinc-600 flex items-center justify-center">
            {creatingSessionMode === 'current' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5 stroke-[2]" />
            )}
          </span>
          <span className="text-sm font-normal">新会话</span>
        </button>

        {/* 状态筛选：仅管理员可见，收成一个图标 + 下拉（不再平铺一整排 tab） */}
        {canOpenSessionReplay && (
          <div className="relative shrink-0 window-no-drag" ref={statusFilterRef}>
            <button
              type="button"
              onClick={() => setStatusFilterOpen((v) => !v)}
              aria-label="按状态筛选会话"
              aria-expanded={statusFilterOpen}
              title={sessionStatusFilter === 'all' ? '按状态筛选会话' : `状态筛选：${activeStatusFilterLabel}`}
              className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                sessionStatusFilter !== 'all'
                  ? 'border-zinc-500 bg-zinc-700/70 text-zinc-100'
                  : 'border-transparent text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
              }`}
            >
              <ListFilter className="h-4 w-4" />
              {sessionStatusFilter !== 'all' && (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-cyan-400" />
              )}
            </button>
            {statusFilterOpen && (
              <div className="absolute right-0 top-full z-30 mt-1 min-w-[160px] rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-xl">
                <div className="px-3 pb-1 pt-1 text-[10px] uppercase tracking-wider text-zinc-500">按状态筛选</div>
                {visibleStatusFilterOptions.map((option) => {
                  const active = sessionStatusFilter === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => { setSessionStatusFilter(option.id); setStatusFilterOpen(false); }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-zinc-700 ${
                        active ? 'text-zinc-100' : 'text-zinc-400'
                      }`}
                    >
                      <Check className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-cyan-400' : 'text-transparent'}`} />
                      <span>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Search Box */}
      <div className="px-2 pb-1 flex-shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话..."
            className="w-full pl-8 pr-7 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-zinc-600 transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-400"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1 overflow-x-auto scrollbar-none">
          {showSearchScopeControls && (
            <>
              {[
                { id: 'current-project' as const, label: '当前项目' },
                { id: 'all' as const, label: '全部' },
              ].map((option) => {
                const active = effectiveSearchScope === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setSearchScope(option.id)}
                    className={`shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                      active
                        ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
                        : 'border-zinc-800 bg-zinc-900/40 text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800/60 hover:text-zinc-300'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
              <span className="h-4 w-px shrink-0 bg-zinc-800" />
            </>
          )}
          {/* 状态筛选已移到顶部「新会话」右侧的筛选图标下拉（仅管理员）。这里只保留搜索范围 + 搜索状态。 */}
          {messageSearchLoading && searchQuery.trim() && (
            <span className="shrink-0 px-1 text-[11px] text-zinc-600">搜消息中...</span>
          )}
        </div>
      </div>

      {/* Session List - Project Grouped */}
      <div className="flex-1 overflow-y-auto px-2 min-h-0">
        {isLoading && sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-primary-400" />
            <span className="text-xs text-zinc-500">加载中...</span>
          </div>
        ) : !hasAnySessions ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-12 h-12 rounded-2xl bg-zinc-800 flex items-center justify-center mb-3">
              <MessageSquare className="w-6 h-6 text-zinc-500" />
            </div>
            <p className="text-sm text-zinc-400 mb-1">暂无对话</p>
            <p className="text-xs text-zinc-500">开始新的对话</p>
          </div>
        ) : filteredSessions.length === 0 && hasSearchFilters ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <Search className="w-6 h-6 text-zinc-600 mb-2" />
            <p className="text-sm text-zinc-500">
              {messageSearchLoading
                ? '搜索消息内容中...'
                : !searchQuery && sessionStatusFilter !== 'all'
                ? `当前没有${activeStatusFilterLabel}会话`
                : '未找到匹配的会话'}
            </p>
          </div>
        ) : (
          /* Workspace/project grouped view, including search and status-filtered results. */
          <div className="py-2">
            {workspaceGroupedSessions.map((group) => {
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
                  key={group.key}
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
                            {renderSessionItem(session as SessionWithMeta)}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 多选模式底部操作栏 */}
      {multiSelectMode && selectedSessionIds.size > 0 && (
        <div className="px-3 py-2 border-t border-zinc-700 flex items-center justify-between">
          <span className="text-xs text-zinc-400">
            已选 {selectedSessionIds.size} 个
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={clearSelection}
              className="text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
            >
              取消
            </button>
            <button
              onClick={batchDelete}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              删除
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
            aria-label={`查看 Agent Neo ${optionalUpdateLabel} 更新内容`}
            title={`查看 Agent Neo ${optionalUpdateLabel} 更新内容`}
            className="group flex w-full items-center gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-200 transition-colors hover:border-indigo-400/30 hover:bg-indigo-500/15 hover:text-indigo-100 focus:outline-hidden"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-indigo-500/15 text-indigo-300 group-hover:text-indigo-200">
              <Download className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-left font-medium">更新可用</span>
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
              aria-label="用户菜单"
              aria-expanded={showUserMenu}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.04] transition-colors"
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="w-7 h-7 rounded-full object-cover"
                />
              ) : (
                <User className="w-5 h-5 text-zinc-500" />
              )}
              <span className="flex-1 text-left text-sm font-medium text-zinc-400 truncate">
                {user.nickname || user.email?.split('@')[0]}
              </span>
              {isVerifiedAdmin ? (
                <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                  管理员
                </span>
              ) : isAdminPendingVerification ? (
                <span
                  className="shrink-0 rounded border border-zinc-500/30 bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300"
                  title={adminPendingTitle}
                >
                  管理员待验证
                </span>
              ) : null}
              <ChevronDown className={`w-4 h-4 text-zinc-600 transition-transform ${showUserMenu ? 'rotate-180' : ''}`} />
            </button>
            {/* User Dropdown Menu */}
            {showUserMenu && (
              <div className="absolute bottom-full left-2 right-2 z-50 max-h-[80vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
                <AccountMenuLabel>常用</AccountMenuLabel>
                <AccountMenuItem
                  onClick={() => { setShowActivityPanel(true); setShowUserMenu(false); }}
                  icon={<Activity className={`w-4 h-4 ${showActivityPanel ? 'text-cyan-400' : 'text-cyan-400/80'}`} />}
                  label="活动"
                />
                <AccountMenuItem
                  onClick={() => { setShowKnowledgeMemoryPanel(true); setShowUserMenu(false); }}
                  icon={<Brain className={`w-4 h-4 ${showKnowledgeMemoryPanel ? 'text-emerald-400' : 'text-emerald-400/80'}`} />}
                  label="知识与记忆"
                />
                <AccountMenuItem
                  onClick={() => { setShowComputerUsePanel(true); setShowUserMenu(false); }}
                  icon={<MousePointerClick className={`w-4 h-4 ${showComputerUsePanel ? 'text-cyan-400' : 'text-cyan-400/80'}`} />}
                  label="桌面操作"
                />
                <AccountMenuItem
                  onClick={() => { setShowCronCenter(!showCronCenter); setShowUserMenu(false); }}
                  icon={<Clock3 className={`w-4 h-4 ${showCronCenter ? 'text-amber-400' : 'text-amber-400/80'}`} />}
                  label="自动化"
                />
                {canOpenPromptManager && (
                  <AccountMenuItem
                    onClick={() => { setShowPromptManager(true); setShowUserMenu(false); }}
                    icon={<ScrollText className="w-4 h-4 text-violet-400/80" />}
                    label="提示词"
                  />
                )}
                {canOpenUserDashboard && (
                  <AccountMenuItem
                    onClick={() => { openSettingsTab('users'); setShowUserMenu(false); }}
                    icon={<Users className="w-4 h-4 text-amber-400/80" />}
                    label="用户管理"
                  />
                )}
                {canOpenInviteCodes && (
                  <AccountMenuItem
                    onClick={() => { openSettingsTab('invites'); setShowUserMenu(false); }}
                    icon={<Ticket className="w-4 h-4 text-amber-400/80" />}
                    label="邀请码管理"
                  />
                )}

                <div className="my-1 border-t border-zinc-800" />
                <button
                  type="button"
                  onClick={() => setShowAccountAdvancedTools((open) => !open)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                >
                  <ChevronRight className={`h-3.5 w-3.5 transition-transform ${advancedToolsOpen ? 'rotate-90' : ''}`} />
                  <span className="min-w-0 flex-1 text-left">高级工具</span>
                  {hasActiveAdvancedTool && (
                    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                      运行中
                    </span>
                  )}
                </button>
                {advancedToolsOpen && (
                  <div className="pb-1">
                    <AccountMenuItem
                      onClick={() => { setShowLab(true); setShowUserMenu(false); }}
                      icon={<FlaskConical className={`w-4 h-4 ${showLab ? 'text-emerald-400' : 'text-emerald-400/80'}`} />}
                      label="模型训练"
                    />
                    <AccountMenuItem
                      onClick={() => { setShowTimeCapabilityCenter(!showTimeCapabilityCenter); setShowUserMenu(false); }}
                      icon={<CalendarDays className={`w-4 h-4 ${showTimeCapabilityCenter ? 'text-sky-400' : 'text-sky-400/80'}`} />}
                      label="时间与能力"
                    />
                    <AccountMenuItem
                      onClick={() => { setShowDesktopPanel(!showDesktopPanel); setShowUserMenu(false); }}
                      icon={<Monitor className={`w-4 h-4 ${showDesktopPanel ? 'text-cyan-400' : 'text-cyan-400/80'}`} />}
                      label="桌面采集"
                    />
                  </div>
                )}

                <div className="border-t border-zinc-800" />
                <AccountMenuItem
                  onClick={() => { setShowSettings(true); setShowUserMenu(false); }}
                  icon={<Settings className="w-4 h-4" />}
                  label="设置"
                />
                <AccountMenuItem
                  onClick={() => { signOut(); setShowUserMenu(false); }}
                  icon={<LogOut className="w-4 h-4" />}
                  label="退出登录"
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
            登录
          </button>
        )}
      </div>

      {/* Replay 摘要 */}
      {replayDialog && (
        <SessionReplaySummaryDialog
          sessionTitle={replayDialog.sessionTitle}
          replay={replayDialog.replay}
          workflowRuns={Object.values(workflowRuns).filter((run) => run.sessionId === replayDialog.sessionId)}
          backgroundTasks={durableBackgroundTasks.filter((task) => task.sessionId === replayDialog.sessionId)}
          evidence={replayEvidenceBySessionId.get(replayDialog.sessionId) ?? []}
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
          message={`已删除 ${pendingDelete.ids.length} 个对话`}
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
