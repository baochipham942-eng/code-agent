// ============================================================================
// App - Main Application Component
// Linear-style UI refactor: Clean layout with task panel
// ============================================================================

import React, { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { useAppStore } from './stores/appStore';
import { useAuthStore, initializeAuthStore } from './stores/authStore';
import { initializeAgentRegistryStore } from './stores/agentRegistryStore';
import { useSessionStore } from './stores/sessionStore';
import { initializeStatusStore } from './stores/statusStore';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TitleBar } from './components/TitleBar';
import { MCPElicitationModal } from './components/MCPElicitationModal';
import { MCPOAuthConsentModal } from './components/MCPOAuthConsentModal';
import { AuthModal } from './components/AuthModal';
import { PasswordResetModal } from './components/PasswordResetModal';
import { ForceUpdateModal } from './components/ForceUpdateModal';
import { UpdateNotification } from './components/UpdateNotification';
import { isDesktopShellMode, isTauriMode } from './utils/platform';
// PermissionDialog moved to PermissionCard inline in ChatView
import { ProjectCollaborationPage } from './components/features/projectCollaboration';
import { ProjectSpacePage } from './components/features/projectSpace';
import { DevServerLauncher } from './components/LivePreview/DevServerLauncher';
import { WorkbenchTabs } from './components/WorkbenchTabs';
import { WorkbenchViewContent } from './components/WorkbenchViewContent';
import { PromptManagerModal } from './components/features/prompts/PromptManagerModal';
import { BackgroundSessionPanel } from './components/features/background';
import { FullScreenPage } from './components/features/shared/FullScreenPage';
import { RoleDetailPage } from './components/features/expert/RoleDetailPage';
import { NativeDesktopSection } from './components/features/settings/sections/NativeDesktopSection';
import { ToolCreateConfirmModal, type ToolCreateRequest } from './components/ConfirmModal';
import { useDoctorStore, DOCTOR_STARTUP_CHECK_DELAY_MS } from './stores/doctorStore';
import { ModelOnboardingModal } from './components/onboarding/ModelOnboardingModal';
import { ConfirmActionModal } from './components/ConfirmActionModal';
import { useDisclosure } from './hooks/useDisclosure';
import { useMemoryEvents } from './hooks/useMemoryEvents';
import { MemoryLearningProvider } from './components/features/memory';
import { ToastContainer } from './components/Toast';
import { ProviderStatusNotice } from './components/ProviderStatusNotice';
import { SessionExpiredNotice } from './components/SessionExpiredNotice';
import { BudgetAlertNotice } from './components/BudgetAlertNotice';
import { FolderTrustDialog, needsFolderTrustDecision, type FolderTrustEvaluationView } from './components/FolderTrustDialog';
import { useTheme } from './hooks/useTheme';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTaskSync } from './hooks/useTaskSync';
import { useInAppValidationBridge } from './hooks/useInAppValidationBridge';
import { useBackgroundTaskSync } from './hooks/useBackgroundTaskSync';
import { useOpenPreviewBridge } from './hooks/useOpenPreviewBridge';
import { useTerminalRevealBridge } from './hooks/useTerminalRevealBridge';
import { useArtifactSurfaceIntent } from './hooks/useArtifactSurfaceIntent';
import { Group as PanelGroup, Panel, Separator as ResizeHandle } from 'react-resizable-panels';
import { MemoFloater } from './components/features/memo/MemoFloater';
import { useAppshots } from './hooks/useAppshots';
import { useSurfaceExecutionPip } from './hooks/useSurfaceExecutionPip';
import { useSurfaceExecutionEffects } from './hooks/agent/effects/useSurfaceExecutionEffects';
import { useAgentHalo } from './hooks/useAgentHalo';
import { useRendererBundleAutoReload } from './hooks/useRendererBundleAutoReload';
import { useI18n } from './hooks/useI18n';
import { toast } from './hooks/useToast';
import { IPC_CHANNELS, IPC_DOMAINS, type NotificationClickedEvent, type NotificationShowEvent, type ToolCreateRequestEvent, type ConfirmActionRequest, type ContextHealthUpdateEvent } from '@shared/ipc';
import { postOsNotification, registerNotificationClick } from './utils/osNotification';
import type { AppSettings, ModelConfig, ModelProvider, UserQuestionRequest, MCPElicitationRequest, MCPOAuthConsentRequest, UpdateInfo, Message } from '@shared/contract';
import { UI, DEFAULT_PROVIDER, DEFAULT_MODEL, getDefaultModelForProvider, getProviderEndpointForProtocol } from '@shared/constants';
import { UNSORTED_PROJECT_ID } from '@shared/contract/project';
import { createLogger } from './utils/logger';
import ipcService from './services/ipcService';
import { useSwarmStore } from './stores/swarmStore';
import { useWorkflowStore } from './stores/workflowStore';
import { useBackgroundTaskStore } from './stores/backgroundTaskStore';
import { tauriCheckForUpdate } from './utils/tauriUpdater';
import { setSentryRendererContext } from './observability/sentryRenderer';
import { applyRendererPrivacyFlags, resolvePrivacyFlags } from './observability/privacyFlags';
import { signalRendererReady, RENDERER_READY_SETTLE_CAP_MS } from './utils/rendererReady';
import { whenInitialSessionStateSettled } from './stores/sessionStore';
import {
  shouldActivateSwarmScopeFromRoot,
  isSwarmSurfaceArtifact,
} from './utils/swarmEventRouting';
import { openSurfaceForArtifact } from './services/surfaceIntentDispatcher';

const logger = createLogger('App');
const SIDEBAR_AUTO_COLLAPSE_WIDTH = 1180;
const WORKBENCH_MIN_VISIBLE_WIDTH = 900;
const TASK_WORKBENCH_BACKGROUND_STATUSES = new Set(['queued', 'running', 'waiting_input', 'stalled', 'paused']);

const SettingsModal = React.lazy(() => import('./components/SettingsModal').then((module) => ({
  default: module.SettingsModal,
})));
const WorkflowPanel = React.lazy(() => import('./components/features/workflow/WorkflowPanel').then((module) => ({
  default: module.WorkflowPanel,
})));
const LabPage = React.lazy(() => import('./components/features/lab/LabPage').then((module) => ({
  default: module.LabPage,
})));
const CapturePanel = React.lazy(() => import('./components/features/capture').then((module) => ({
  default: module.CapturePanel,
})));
const KnowledgeMemoryPanel = React.lazy(() => import('./components/features/knowledge/KnowledgeMemoryPanel').then((module) => ({
  default: module.KnowledgeMemoryPanel,
})));
const LibraryPanel = React.lazy(() => import('./components/features/knowledge/LibraryPanel').then((module) => ({
  default: module.LibraryPanel,
})));
const CapabilityHubPage = React.lazy(() => import('./components/features/capabilityHub/CapabilityHubPage').then((module) => ({
  default: module.CapabilityHubPage,
})));
const CronCenterPanel = React.lazy(() => import('./components/features/cron/CronCenterPanel').then((module) => ({
  default: module.CronCenterPanel,
})));
const TimeCapabilityPanel = React.lazy(() => import('./components/features/timeCapability/TimeCapabilityPanel'));
const AgentTeamPanel = React.lazy(() => import('./components/features/agentTeam').then((module) => ({
  default: module.AgentTeamPanel,
})));
const ActivityPanel = React.lazy(() => import('./components/features/activity/ActivityPanel').then((module) => ({
  default: module.ActivityPanel,
})));
const LocalOpsPage = React.lazy(() => import('./components/features/localOps/LocalOpsPage').then((module) => ({
  default: module.LocalOpsPage,
})));
const EvalCenterPage = React.lazy(() => import('./components/features/evalCenter/EvalCenterPage').then((module) => ({
  default: module.EvalCenterPage,
})));

async function invokeDomain<T>(domain: string, action: string, payload?: unknown): Promise<T> {
  return ipcService.invokeDomain<T>(domain, action, payload);
}

// ── 响应式断点 hook ──
function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    let raf: number;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setWidth(window.innerWidth));
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); cancelAnimationFrame(raf); };
  }, []);
  return width;
}

export const App: React.FC = () => {
  const { t } = useI18n();
  useAppshots(); // 挂载 Appshots 事件监听（热键截图 → composer）
  useSurfaceExecutionPip(); // 当前会话 Browser / Computer 共享的可信实时 PiP
  useAgentHalo(); // CUA 原生驱动时的系统级光晕跟随（单指针共驾聚光灯）
  const {
    showSettings,
    showPromptManager,
    showDesktopPanel,
    setTaskPanelTab,
    showCapabilityHub,
    expertDetailRoleId,
    showCronCenter,
    setShowCronCenter,
    showTimeCapabilityCenter,
    setShowFileExplorer,
    showAgentTeamPanel,
    setShowAgentTeamPanel,
    selectedSwarmAgentId,
    showLab,
    showLocalOpsPanel,
    showEvalCenter,
    showProjectCollaborationPage,
    projectCollaborationPageProjectId,
    closeProjectCollaborationPage,
    showProjectSpacePage,
    closeProjectSpacePage,
    showKnowledgeMemoryPanel,
    showLibraryPanel,
    showActivityPanel,
    setShowActivityPanel,
    setShowSettings,
    setLanguage,
    setOptionalUpdateInfo,
    optionalUpdateInfo,
    showOptionalUpdateModal,
    setShowOptionalUpdateModal,
    workbenchTabs,
    activeWorkbenchTab,
    workbenchCollapsed,
    openWorkbenchTab,
    syncTaskWorkbenchForActivity,
    pendingPermissionRequest,
    pendingPermissionSessionId,
    queuedPermissionRequests,
  } = useAppStore();

  // 响应式：窄屏先把横向空间让给聊天和右侧状态面板。
  const windowWidth = useWindowWidth();
  const isNarrowViewport = windowWidth < SIDEBAR_AUTO_COLLAPSE_WIDTH;
  // 右栏「只在需要时出现」（2026-07-27 审美关拍板）= **默认收起**（appStore 初值 true），
  // 不是「没视图就不占位」——后者会把空态启动器里的四个发现入口（概览/文件/浏览器/设计画布）
  // 一并藏掉，对非程序员用户等于砍掉可达路径（e2e 当场抓到）。
  // 收起态顶栏留展开入口；打开任一视图（openWorkbenchTab，非 auto 源）也会顺带清收起位。
  const showWorkbench = windowWidth >= WORKBENCH_MIN_VISIBLE_WIDTH && !workbenchCollapsed;
  const isPreviewActive = typeof activeWorkbenchTab === 'string' && activeWorkbenchTab.startsWith('preview:');
  const showNarrowWorkbench =
    !workbenchCollapsed &&
    windowWidth < WORKBENCH_MIN_VISIBLE_WIDTH &&
    workbenchTabs.length > 0 &&
    (isPreviewActive || activeWorkbenchTab === 'overview' || activeWorkbenchTab === 'browser');
  const appliedNarrowSidebarDefaultRef = useRef(false);

  const [mcpElicitation, setMcpElicitation] = useState<MCPElicitationRequest | null>(null);
  const [mcpOAuthConsent, setMcpOAuthConsent] = useState<MCPOAuthConsentRequest | null>(null);

  // 强制更新状态
  const [forceUpdateInfo, setForceUpdateInfo] = useState<UpdateInfo | null>(null);

  // 新手模型配置引导
  const [showModelOnboarding, setShowModelOnboarding] = useState(false);
  const [authInitialMode, setAuthInitialMode] = useState<'signin' | 'signup'>('signin');
  const modelOnboardingCompletedRef = useRef(false);

  // 工具创建确认弹窗
  const [toolCreateRequest, setToolCreateRequest] = useState<ToolCreateRequest | null>(null);

  // confirm_action 弹窗确认
  const [confirmActionRequest, setConfirmActionRequest] = useState<ConfirmActionRequest | null>(null);
  const [folderTrustEvaluation, setFolderTrustEvaluation] = useState<FolderTrustEvaluationView | null>(null);
  const [folderTrustBusy, setFolderTrustBusy] = useState(false);

  // Auth store
  const { showAuthModal, showPasswordResetModal, isLoading: isAuthLoading } = useAuthStore();
  const sentryUserId = useAuthStore((state) => state.user?.id ?? null);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  useSurfaceExecutionEffects(currentSessionId);
  const currentProjectId = useSessionStore((state) => {
    const session = state.sessions.find((item) => item.id === state.currentSessionId);
    return session?.projectId && session.projectId !== UNSORTED_PROJECT_ID ? session.projectId : null;
  });
  const visibleProjectCollaborationProjectId = projectCollaborationPageProjectId ?? currentProjectId;
  const sessionTasks = useSessionStore((state) => state.sessionTasks);
  const todos = useSessionStore((state) => state.todos);
  const backgroundTasks = useBackgroundTaskStore((state) => state.tasks);
  const swarmIsRunning = useSwarmStore((state) => state.isRunning);
  const swarmExecutionPhase = useSwarmStore((state) => state.executionPhase);
  const swarmLaunchRequests = useSwarmStore((state) => state.launchRequests);
  const swarmPlanReviews = useSwarmStore((state) => state.planReviews);
  const swarmActiveSessionId = useSwarmStore((state) => state.activeSessionId);
  const swarmActiveRunId = useSwarmStore((state) => state.activeRunId);
  const workflowSnapshot = useWorkflowStore((state) => state.activeSnapshot(currentSessionId ?? undefined));
  const workflowPendingLaunchRequest = useWorkflowStore((state) => (
    state.pendingLaunchRequest(currentSessionId ?? undefined)
  ));

  // 渐进披露 Hook（权限层：*Enabled 表示功能是否可用）
  const { isStandard, dagPanelEnabled } = useDisclosure();

  // Panel toggle states from appStore（用户偏好层：show* 表示用户手动开关）
  const {
    showDAGPanel,
    setShowDAGPanel,
  } = useAppStore();


  // Theme Hook - 初始化主题系统
  useTheme();

  // Task state 同步：mount 时拉取后端 sessionStates + 30s 兜底轮询
  // 防止 dev server 重启 / 网络断开导致前端 isProcessing 卡住不放
  useTaskSync({ pollInterval: 30_000 });
  useBackgroundTaskSync();
  useInAppValidationBridge();
  // 2b：监听 agent（ProposeSlidesOps 等）生成文档型产物后请求打开预览 tab（按当前会话过滤）。
  useOpenPreviewBridge();
  useTerminalRevealBridge();
  useArtifactSurfaceIntent();
  useRendererBundleAutoReload();

  // 全局快捷键（命令面板、设置、会话导航等；compact 只有用户显式绑定后才会触发）
  useKeyboardShortcuts({
    customHandlers: {
      triggerCompact: async () => {
        try {
          const currentSessionId = useSessionStore.getState().currentSessionId;
          await ipcService.invoke(
            IPC_CHANNELS.CONTEXT_COMPACT_CURRENT,
            currentSessionId ?? undefined,
          );
          if (currentSessionId) {
            await useSessionStore.getState().refreshContextHealth(currentSessionId);
          }
        } catch { /* ignore */ }
      },
    },
  });

  // Memory 事件监听
  useMemoryEvents({
    onMemoryLearned: (data) => {
      logger.info('Memory learning completed', {
        knowledgeExtracted: data.knowledgeExtracted,
        codeStylesLearned: data.codeStylesLearned,
        toolPreferencesUpdated: data.toolPreferencesUpdated,
      });
      // 可以在这里添加 Toast 通知或其他 UI 反馈
    },
  });

  // Debug: Check if the bridge API is available on mount
  useEffect(() => {
    logger.debug('Mount - bridge API available', { available: ipcService.isAvailable() });
    if (ipcService.isAvailable()) {
      logger.debug('bridge API available');
    }
    // 首次渲染 commit 后,等初始会话数据落定(带上限)再通知桌面壳显示窗口:
    // 首帧就显示会把"空聊天→内容弹入"的水合过程暴露给用户(启动闪烁的另一形态)。
    const settleCap = new Promise<void>((resolve) => {
      window.setTimeout(resolve, RENDERER_READY_SETTLE_CAP_MS);
    });
    void Promise.race([whenInitialSessionStateSettled(), settleCap]).then(() => signalRendererReady());
  }, []);

  // Initialize auth store on mount
  useEffect(() => {
    initializeAuthStore().catch((error) => {
      logger.error('Failed to initialize auth store', error);
    });
  }, []);

  useEffect(() => {
    setSentryRendererContext({ sessionId: currentSessionId, userId: sentryUserId });
  }, [currentSessionId, sentryUserId]);

  useLayoutEffect(() => {
    // Swarm events are process-wide broadcasts, while the visible Team is session-bound.
    // Activating the selected session either restores its latest run snapshot or clears the
    // projection immediately, so the previous session's agents/messages cannot linger.
    useSwarmStore.getState().activateScope(currentSessionId);
    useAppStore.getState().setSelectedSwarmAgentId(null);
  }, [currentSessionId]);

  // Initialize agent registry store (custom .md agents 列表 + 热加载推送订阅)
  useEffect(() => {
    initializeAgentRegistryStore().catch((error) => {
      logger.error('Failed to initialize agent registry store', error);
    });
  }, []);

  useEffect(() => {
    initializeStatusStore().catch((error) => {
      logger.error('Failed to hydrate today cost', error);
    });
  }, []);

  // Load settings from backend on mount
  const { setModelConfig, setDisclosureLevel, sidebarCollapsed, setSidebarCollapsed } = useAppStore();

  const openModelOnboardingIfNeeded = useCallback(async (preferSignup = false) => {
    if (modelOnboardingCompletedRef.current) return;
    try {
      const configured = await invokeDomain<boolean>(IPC_DOMAINS.SETTINGS, 'checkApiKeyConfigured');
      if (configured) {
        modelOnboardingCompletedRef.current = true;
        return;
      }

      const authState = useAuthStore.getState();
      if (!authState.isAuthenticated) {
        setAuthInitialMode(preferSignup ? 'signup' : 'signin');
        authState.setShowAuthModal(true);
        return;
      }

      setShowModelOnboarding(true);
    } catch (error) {
      logger.error('Failed to check model onboarding state', error);
    }
  }, []);

  // 从最新 settings 读激活模型并推入 store（初始加载与 onboarding 自动解除共用）。
  const loadActiveModelConfig = useCallback(async () => {
    try {
      const settings = await invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
      // renderer 侧遥测通道跟随隐私开关（host 侧对应 privacyGate；boot 一次 + 设置页切换时重放）
      applyRendererPrivacyFlags(resolvePrivacyFlags(settings));
      if (!settings?.models) return;
      const defaultProvider = (settings.models.defaultProvider || settings.models.default || DEFAULT_PROVIDER) as ModelProvider;
      const providerConfig = settings.models.providers?.[defaultProvider];
      if (!providerConfig) return;
      const model = providerConfig.model || getDefaultModelForProvider(defaultProvider) || DEFAULT_MODEL;
      const modelSettings = providerConfig.models?.[model];
      setModelConfig({
        provider: defaultProvider,
        model,
        apiKey: providerConfig.apiKey || '',
        baseUrl: providerConfig.baseUrl || getProviderEndpointForProtocol(defaultProvider, providerConfig.protocol) || '',
        protocol: providerConfig.protocol,
        temperature: providerConfig.temperature ?? 0.7,
        maxTokens: modelSettings?.maxTokens ?? providerConfig.maxTokens ?? 4096,
        capabilities: modelSettings?.capabilities,
      });
    } catch (error) {
      logger.error('Failed to load active model config', error);
    }
  }, [setModelConfig]);

  // onboarding 弹窗期间，若团队共享 provider（中转站）登录后被下发到位，自动关闭弹窗并切到共享模型，
  // 不让没配 key 的同事卡在"配置 key"弹窗上。
  useEffect(() => {
    if (!showModelOnboarding) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const configured = await invokeDomain<boolean>(IPC_DOMAINS.SETTINGS, 'checkApiKeyConfigured');
        if (cancelled || !configured) return;
        modelOnboardingCompletedRef.current = true;
        await loadActiveModelConfig();
        if (!cancelled) setShowModelOnboarding(false);
      } catch {
        // 忽略单次轮询失败，下次再试
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [showModelOnboarding, loadActiveModelConfig]);

  useEffect(() => {
    if (!isNarrowViewport) {
      appliedNarrowSidebarDefaultRef.current = false;
      return;
    }

    if (!appliedNarrowSidebarDefaultRef.current && !sidebarCollapsed) {
      appliedNarrowSidebarDefaultRef.current = true;
      setSidebarCollapsed(true);
    }
  }, [isNarrowViewport, setSidebarCollapsed, sidebarCollapsed]);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');

        // 加载语言设置
        if (settings?.ui?.language) {
          setLanguage(settings.ui.language);
          logger.info('Loaded language setting', { language: settings.ui.language });
        }

        // 加载界面设置（渐进披露级别）
        if (settings?.ui?.disclosureLevel) {
          setDisclosureLevel(settings.ui.disclosureLevel);
          logger.info('Loaded disclosure level', { level: settings.ui.disclosureLevel });
        }

        // 加载开发者模式
        if (settings?.ui?.developerMode) {
          useAppStore.getState().setDeveloperMode(true);
          logger.info('Loaded developer mode', { enabled: true });
        }


        // 加载模型配置
        if (settings?.models) {
          const defaultProvider = (settings.models.defaultProvider || settings.models.default || DEFAULT_PROVIDER) as ModelProvider;
          const providerConfig = settings.models.providers?.[defaultProvider];

          if (providerConfig) {
            const model = providerConfig.model || getDefaultModelForProvider(defaultProvider) || DEFAULT_MODEL;
            const modelSettings = providerConfig.models?.[model];
            setModelConfig({
              provider: defaultProvider,
              model,
              apiKey: providerConfig.apiKey || '',
              baseUrl: providerConfig.baseUrl || getProviderEndpointForProtocol(defaultProvider, providerConfig.protocol) || '',
              protocol: providerConfig.protocol,
              temperature: providerConfig.temperature ?? 0.7,
              maxTokens: modelSettings?.maxTokens ?? providerConfig.maxTokens ?? 4096,
              capabilities: modelSettings?.capabilities,
            });
            logger.info('Loaded model config for provider', { provider: defaultProvider });
          }
        }
      } catch (error) {
        logger.error('Failed to load settings', error);
      }
    };
    loadSettings();
  }, [setLanguage, setModelConfig, setDisclosureLevel]);

  const refreshFolderTrust = useCallback(async () => {
    try {
      const evaluation = await invokeDomain<FolderTrustEvaluationView>(IPC_DOMAINS.FOLDER_TRUST, 'get');
      setFolderTrustEvaluation(needsFolderTrustDecision(evaluation) ? evaluation : null);
    } catch (error) {
      logger.warn('Failed to evaluate folder trust', { error });
    }
  }, []);

  useEffect(() => {
    void refreshFolderTrust();
  }, [refreshFolderTrust]);

  const setFolderTrustDecision = useCallback(async (state: 'trusted' | 'blocked') => {
    setFolderTrustBusy(true);
    try {
      const evaluation = await invokeDomain<FolderTrustEvaluationView>(
        IPC_DOMAINS.FOLDER_TRUST,
        'set',
        { state },
      );
      // 决定已生效（trusted 或 blocked）就关窗；只有 host 回报仍是未决定态才继续问。
      setFolderTrustEvaluation(needsFolderTrustDecision(evaluation) ? evaluation : null);
    } catch (error) {
      // 只写日志的话按钮看起来「点了没反应」，用户无从知道决定没保存上。
      logger.warn('Failed to update folder trust', { error });
      toast.error(t.folderTrust.saveFailed + (error instanceof Error ? `: ${error.message}` : ''));
    } finally {
      setFolderTrustBusy(false);
    }
  }, [t]);

  // 应用启动时检查更新（强制更新检查）
  useEffect(() => {
    if (!isDesktopShellMode()) return;

    const checkForUpdates = async () => {
      try {
        logger.info('Checking for updates on startup');
        const updateInfo = isTauriMode()
          ? await tauriCheckForUpdate()
          : await invokeDomain<UpdateInfo>(IPC_DOMAINS.UPDATE, 'check');

        if (!isTauriMode() && updateInfo?.hasUpdate && updateInfo?.forceUpdate) {
          logger.info('Force update required', { latestVersion: updateInfo.latestVersion });
          setForceUpdateInfo(updateInfo);
          setOptionalUpdateInfo(null);
        } else if (updateInfo?.hasUpdate) {
          logger.info('Optional update available', { latestVersion: updateInfo.latestVersion });
          setOptionalUpdateInfo(updateInfo);
        } else {
          logger.info('App is up to date');
          setOptionalUpdateInfo(null);
        }
      } catch (error) {
        logger.error('Failed to check for updates', error);
      }
    };

    // 延迟检查，等待应用完全加载
    const timer = setTimeout(checkForUpdates, UI.STARTUP_UPDATE_CHECK_DELAY);
    return () => clearTimeout(timer);
  }, [setOptionalUpdateInfo]);

  // 首次启动检测账号和模型是否已就绪
  useEffect(() => {
    if (isAuthLoading) return;

    // 延迟检查，等待应用完全加载
    const timer = setTimeout(() => {
      void openModelOnboardingIfNeeded(true);
    }, UI.STARTUP_API_KEY_CHECK_DELAY);
    return () => clearTimeout(timer);
  }, [isAuthLoading, openModelOnboardingIfNeeded]);

  // 启动后延迟静默跑一次诊断快检（skipNetwork）：有 fail 项才在侧栏亮红点，全绿不打扰
  useEffect(() => {
    const timer = setTimeout(() => {
      void useDoctorStore.getState().runSilentStartupCheck();
    }, DOCTOR_STARTUP_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  // 监听工具创建确认请求
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.SECURITY_TOOL_CREATE_REQUEST,
      (request: ToolCreateRequestEvent) => {
        logger.info('Received tool create request', { name: request.name });
        setToolCreateRequest(request);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for user question events (Gen 3+)
  // G2 拍板形态：问题进 pending 队列，由 ChatView 的打断式选项卡（遮盖 composer）
  // 渲染，不再弹全局 Modal。无 sessionId 的请求绑到当前会话，保证用户总能答到。
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.USER_QUESTION_ASK,
      (request: UserQuestionRequest) => {
        logger.info('Received user question', { id: request.id, sessionId: request.sessionId });
        const withSession = request.sessionId
          ? request
          : { ...request, sessionId: useSessionStore.getState().currentSessionId ?? undefined };
        useSessionStore.getState().addPendingUserQuestion(withSession);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for MCP elicitation events
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.MCP_ELICITATION_REQUEST,
      (request: MCPElicitationRequest) => {
        logger.info('Received MCP elicitation request', { id: request.id, server: request.serverName });
        setMcpElicitation(request);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for MCP OAuth consent events
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.MCP_OAUTH_CONSENT_REQUEST,
      (request: MCPOAuthConsentRequest) => {
        logger.info('Received MCP OAuth consent request', { id: request.requestId, server: request.serverName });
        setMcpOAuthConsent(request);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for notification click events (切换到对应会话)
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.NOTIFICATION_CLICKED,
      (event: NotificationClickedEvent) => {
        logger.info('Notification clicked, switching to session', { sessionId: event.sessionId });
        void useSessionStore.getState().switchSession(event.sessionId);
        openWorkbenchTab('task');
        setTaskPanelTab('monitor');
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [openWorkbenchTab, setTaskPanelTab]);

  // 主进程请求发原生系统通知（Tauri 通知插件，带 Agent Neo 图标/身份）。
  // 点击经 onAction best-effort 跳到最近一条通知对应的会话。
  const lastNotifSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      (event: NotificationShowEvent) => {
        lastNotifSessionIdRef.current = event.sessionId;
        void postOsNotification({ title: event.title, body: event.body });
      }
    );
    void registerNotificationClick(() => {
      const sessionId = lastNotifSessionIdRef.current;
      if (!sessionId) return;
      void useSessionStore.getState().switchSession(sessionId);
      openWorkbenchTab('task');
      setTaskPanelTab('monitor');
    });

    return () => {
      unsubscribe?.();
    };
  }, [openWorkbenchTab, setTaskPanelTab]);

  // 会话级自动化回流消息：主进程写入 automation 通知后实时推过来。
  // 打开中的源会话即时 append（去重，乐观插入的 created 通知会命中去重），
  // 其他会话标记未读由侧栏徽标提示，无需等切换重载才可见。
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.SESSION_AUTOMATION_MESSAGE,
      (payload: { sessionId?: string; message?: Message }) => {
        if (!payload?.sessionId || !payload.message?.id) return;
        const store = useSessionStore.getState();
        if (payload.sessionId === store.currentSessionId) {
          if (!store.messages.some((m) => m.id === payload.message!.id)) {
            store.addMessage(payload.message);
          }
        } else {
          store.markSessionUnread(payload.sessionId);
        }
      }
    );
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for confirm_action events (Gen 3+)
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.CONFIRM_ACTION_ASK,
      (request: ConfirmActionRequest) => {
        logger.info('Received confirm action request', { id: request.id, title: request.title });
        setConfirmActionRequest(request);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for context health updates
  const { setContextHealth } = useAppStore();
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.CONTEXT_HEALTH_EVENT,
      (event: ContextHealthUpdateEvent) => {
        // 只更新当前会话的健康状态
        const currentSessionId = useSessionStore.getState().currentSessionId;
        if (event.sessionId === currentSessionId) {
          setContextHealth(event.health);
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [setContextHealth]);

  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.SWARM_EVENT,
      (event) => {
        const selectedSessionId = useSessionStore.getState().currentSessionId;
        const swarmState = useSwarmStore.getState();
        const shouldActivateScope = shouldActivateSwarmScopeFromRoot(
          event,
          selectedSessionId,
          swarmState,
        );
        if (isSwarmSurfaceArtifact(event)) {
          openSurfaceForArtifact({
            artifact: { kind: 'swarm-monitor' },
            artifactSessionId: event.sessionId,
          });
        }
        swarmState.handleEvent(event);
        if (shouldActivateScope) {
          useSwarmStore.getState().activateScope(event.sessionId, event.runId);
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  const hasOpenSessionTask = sessionTasks.some((task) =>
    task.status === 'pending' || task.status === 'in_progress' || task.status === 'blocked'
  );
  const hasOpenTodo = todos.some((todo) => todo.status !== 'completed');
  const hasVisiblePermissionRequest = Boolean(
    pendingPermissionRequest
    && (!pendingPermissionSessionId || !currentSessionId || pendingPermissionSessionId === currentSessionId),
  );
  const hasQueuedPermissionRequest = Boolean(
    (currentSessionId && (queuedPermissionRequests[currentSessionId]?.length ?? 0) > 0)
    || (queuedPermissionRequests.global?.length ?? 0) > 0,
  );
  const hasBackgroundTaskActivity = Boolean(
    currentSessionId
    && backgroundTasks.some((task) =>
      task.sessionId === currentSessionId
      && TASK_WORKBENCH_BACKGROUND_STATUSES.has(task.status)
    ),
  );
  const hasSwarmActivity = Boolean(
    swarmIsRunning
    || swarmExecutionPhase === 'planning'
    || swarmExecutionPhase === 'waiting_approval'
    || swarmExecutionPhase === 'executing'
    || swarmLaunchRequests.some((request) => request.status === 'pending')
    || swarmPlanReviews.some((review) => review.status === 'pending'),
  );
  const hasWorkflowActivity = Boolean(
    workflowPendingLaunchRequest
    || workflowSnapshot?.status === 'pending'
    || workflowSnapshot?.status === 'running',
  );
  // E-3: 右栏 TaskPanel「按需展开」。只用真实内容信号（待办/任务/待确认/后台/swarm/workflow）
  // 决定自动展开，不再因为会话处于 thinking/processing 这类瞬时运行态就展开——否则未开始/
  // 纯思考阶段会出现「没内容却占地」。无内容时自动收起（auto 源），用户手动开的仍保留。
  const hasTaskWorkbenchContent = (
    hasOpenSessionTask
    || hasOpenTodo
    || hasVisiblePermissionRequest
    || hasQueuedPermissionRequest
    || hasBackgroundTaskActivity
    || hasSwarmActivity
    || hasWorkflowActivity
  );

  useEffect(() => {
    syncTaskWorkbenchForActivity(hasTaskWorkbenchContent);
  }, [hasTaskWorkbenchContent, syncTaskWorkbenchForActivity]);

  // dynamic-workflow 进度树事件通道（P3a）：workflow.ipc 专用 bridge 把 'workflow' domain
  // 投递到 'workflow:event'，payload 即完整 ScriptRunEvent（与 swarm 同款 raw-event 风格）。
  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.WORKFLOW_EVENT, (event) => {
      if (event) useWorkflowStore.getState().handleEvent(event);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  // dynamic-workflow 启动审批事件通道（P3b）：'workflow:launch:event' → 审批卡状态。
  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.WORKFLOW_LAUNCH_EVENT, (event) => {
      if (event) useWorkflowStore.getState().handleLaunchEvent(event);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  // 侧栏是否真的在画（收起 / 非 standard 档都不画）——顶栏该不该存在跟着它走。
  const isSidebarVisible = isStandard && !sidebarCollapsed;
  // 侧栏常驻的 inline 二级页（能力中心/资料库/自动化/专家详情/知识记忆/本机操作/评测中心，
  // 以及 2026-07-29 起统一收进 inline 的账号菜单页：提示词库/Lab/时间能力/活动/
  // Neo 协同/桌面状态）在位时，顶栏收敛。评测中心 2026-07-27 拍板从 overlay 改 inline，一并计入。
  // 设置页 2026-07-30 起是 overlay 整窗覆盖（X5.5-B1），本就不是 inline 页；仍留在名单里
  // 只为压住底下的顶栏不随设置开关抖动（覆盖层在位时它反正不可见）。
  const inlineSecondaryPageActive = Boolean(
    expertDetailRoleId || showKnowledgeMemoryPanel || showLibraryPanel
    || showCapabilityHub || showCronCenter || showLocalOpsPanel || showEvalCenter
    || showProjectSpacePage
    || showSettings || showPromptManager || showLab || showTimeCapabilityCenter
    || showActivityPanel || showProjectCollaborationPage || showDesktopPanel
  );

  const renderWorkbenchContent = () => (
    <div className="flex flex-col h-full bg-zinc-900">
      <WorkbenchTabs>
        {activeWorkbenchTab && (
          <div className="h-full min-h-0 overflow-hidden">
            <WorkbenchViewContent
              activeView={activeWorkbenchTab}
              onCloseFiles={() => setShowFileExplorer(false)}
            />
          </div>
        )}
      </WorkbenchTabs>
    </div>
  );

  return (
    <ErrorBoundary>
      <MemoryLearningProvider>
      <ToastContainer />
      <ProviderStatusNotice />
      <BudgetAlertNotice />
      <SessionExpiredNotice />
      <div className="h-screen flex flex-col bg-zinc-950 text-zinc-200">
        {/* 左右结构（2026-07-27 拍板「右侧标题栏和下面样式上打通」，参照 Codex）：
            左栏一块面（zinc-950）+ 一条竖分隔线 + 右栏一块面（zinc-900），
            右栏顶栏与右栏内容共用同一底色、同一左右边界 ⇒ 顶栏读作右栏的一部分，
            而不是横贯窗口的一条上边。底色写在右栏容器上（唯一真源），
            TitleBar / FullScreenPage(inline) / ChatView / Workbench 都是它的透明子面。 */}
        <div className="flex-1 flex overflow-hidden">
          {isSidebarVisible && (
            <div className="flex flex-col w-60 bg-zinc-950 border-r border-zinc-800">
              <Sidebar />
            </div>
          )}

          {/* Right Area: Chat + TaskPanel with shared title bar */}
          <div className="flex-1 flex flex-col min-w-0 bg-zinc-900">
            {/* Right Title Bar（二级页分支，全宽）—— 三个槽位全空时整条不渲染（2026-07-27 审美关）：
                侧栏收起开关已挪回侧栏自己头上，顶栏只在收起态留展开入口；
                二级页在位时会话动作与右栏开关也都没有对象。于是「二级页 + 侧栏展开」
                这一档顶栏什么都不剩，留着只是一条空的 h-12 边框——不画，让大标题贴顶。
                2026-07-30 第四波②：正常会话分支的顶栏并入聊天列（见下 PanelGroup），
                右栏 workbench 列通顶、tab 条贴面板最顶（WorkBuddy 形态），不再在 tab 条上方
                压一行只有拖拽区的空档；二级页分支顶栏仍全宽（本分支）。 */}
            {inlineSecondaryPageActive && !isSidebarVisible && (
              <TitleBar secondaryPageActive />
            )}

            {/* Content Area */}
            <div className="flex-1 min-h-0 flex overflow-hidden">
              {/* 账号菜单打开的页面统一排进同一条互斥级联（2026-07-29 拍板），
                  排在既有二级页之前 = 沿用 overlay 时代「后开者盖住先开者、关掉后露出」的语义；
                  提示词库排在设置前，于是设置内（SoulSettings）打开提示词库时盖住设置、关闭回到设置。
                  设置页自身 2026-07-30 起是 overlay 整窗覆盖（X5.5-B1），其余账号菜单页仍是 inline。 */}
              {showDesktopPanel ? (
                <FullScreenPage testId="desktop-status-panel" variant="inline">
                  <NativeDesktopSection
                    variant="fullscreen"
                    onClose={() => useAppStore.getState().setShowDesktopPanel(false)}
                  />
                </FullScreenPage>
              ) : showProjectCollaborationPage ? (
                <ProjectCollaborationPage
                  projectId={visibleProjectCollaborationProjectId}
                  onClose={closeProjectCollaborationPage}
                />
              ) : showActivityPanel ? (
                <React.Suspense fallback={null}>
                  <ActivityPanel onClose={() => setShowActivityPanel(false)} />
                </React.Suspense>
              ) : showTimeCapabilityCenter ? (
                <React.Suspense fallback={null}>
                  <TimeCapabilityPanel onClose={() => useAppStore.getState().setShowTimeCapabilityCenter(false)} />
                </React.Suspense>
              ) : showLab ? (
                <React.Suspense fallback={null}>
                  <LabPage />
                </React.Suspense>
              ) : showPromptManager ? (
                <PromptManagerModal />
              ) : showSettings ? (
                <React.Suspense fallback={null}>
                  <SettingsModal />
                </React.Suspense>
              ) : expertDetailRoleId ? (
                <RoleDetailPage roleId={expertDetailRoleId} />
              ) : showKnowledgeMemoryPanel ? (
                <React.Suspense fallback={null}>
                  <KnowledgeMemoryPanel />
                </React.Suspense>
              ) : showLibraryPanel ? (
                <React.Suspense fallback={null}>
                  <LibraryPanel />
                </React.Suspense>
              ) : showCapabilityHub ? (
                <React.Suspense fallback={null}>
                  <CapabilityHubPage />
                </React.Suspense>
              ) : showProjectSpacePage ? (
                <ProjectSpacePage onClose={closeProjectSpacePage} />
              ) : showCronCenter ? (
                <React.Suspense fallback={null}>
                  <CronCenterPanel onClose={() => setShowCronCenter(false)} />
                </React.Suspense>
              ) : showLocalOpsPanel ? (
                <React.Suspense fallback={null}>
                  <LocalOpsPage />
                </React.Suspense>
              ) : showEvalCenter ? (
                <React.Suspense fallback={null}>
                  <EvalCenterPage />
                </React.Suspense>
              ) : (
                <PanelGroup orientation="horizontal" className="flex-1 min-h-0" id="main-layout">
                  <Panel minSize="30" id="chat">
                    <div className="flex flex-col h-full min-h-0 min-w-0 bg-zinc-900">
                      {/* 正常会话的顶栏住在聊天列里（第四波②）：右栏展开时 workbench 列
                          通顶、tab 条贴窗口最顶（WorkBuddy）；右栏开关仍在顶栏右端那组，
                          两态同一行同一槽位（2026-07-27 房规：纵向不跳、顶栏单点可达）。 */}
                      <TitleBar />
                      {showNarrowWorkbench ? renderWorkbenchContent() : <ChatView />}
                    </div>
                  </Panel>

                  {showWorkbench && (
                    <ResizeHandle className="w-1 hover:w-1.5 bg-zinc-800 hover:bg-primary-500/50 transition-all cursor-col-resize" />
                  )}
                  {/* 2026-07-27 拍板（Kimi 三栏占比分析）：min 15%→22%（15% 在 1440 宽下仅
                      180px，任何视图都不可用）、max 45%→35%（2560 下 1044px 远超需要） */}
                  {showWorkbench && (
                    <Panel defaultSize="32" minSize="22" maxSize="35" id="right-panel">
                      {renderWorkbenchContent()}
                    </Panel>
                  )}
                </PanelGroup>
              )}
            </div>
          </div>
      </div>

      {/* V2-A: DevServerLauncher 自管 visibility，挂全局 */}
      <DevServerLauncher />

      {/* Workflow Page - 全屏工作流可视化 */}
      {dagPanelEnabled && showDAGPanel && (
        <React.Suspense fallback={null}>
          <WorkflowPanel onClose={() => setShowDAGPanel(false)} />
        </React.Suspense>
      )}



      {/* User Question：G2 起改为 ChatView 内打断式选项卡（遮盖 composer），不再挂全局 Modal */}

      {/* MCP Elicitation Modal */}
      {mcpElicitation && (
        <MCPElicitationModal
          request={mcpElicitation}
          onClose={() => setMcpElicitation(null)}
        />
      )}

      {/* MCP OAuth Consent Modal */}
      {mcpOAuthConsent && (
        <MCPOAuthConsentModal
          request={mcpOAuthConsent}
          onClose={() => setMcpOAuthConsent(null)}
        />
      )}

      {/* Permission Card - 已移至 ChatView 内联显示 */}

      {/* Auth Modal */}
      {showAuthModal && (
        <AuthModal
          initialMode={authInitialMode}
          onAuthSuccess={() => {
            void openModelOnboardingIfNeeded(false);
          }}
          onCloseComplete={() => setAuthInitialMode('signin')}
        />
      )}

      {/* Password Reset Modal - 设置新密码弹窗 */}
      {showPasswordResetModal && <PasswordResetModal />}

      {/* Force Update Modal - 强制更新，不可关闭 */}
      {isDesktopShellMode() && !isTauriMode() && forceUpdateInfo && <ForceUpdateModal updateInfo={forceUpdateInfo} />}

      {/* Optional Update Modal - 非强制更新，由左下角入口触发 */}
      {isDesktopShellMode() && showOptionalUpdateModal && optionalUpdateInfo && !optionalUpdateInfo.forceUpdate && (
        <UpdateNotification
          updateInfo={optionalUpdateInfo}
          onClose={() => setShowOptionalUpdateModal(false)}
        />
      )}

      {/* 实时语音 Phase 0 spike：dev-only 隐藏入口，靠 localStorage 开关打开 */}

      {/* Model Onboarding Modal - 首次启动引导 */}
      {showModelOnboarding && (
        <ModelOnboardingModal
          onComplete={(config: ModelConfig) => {
            modelOnboardingCompletedRef.current = true;
            setModelConfig(config);
            setShowModelOnboarding(false);
            setShowSettings(false);
          }}
          onSkip={() => {
            // 跳过不算完成：不置 completedRef，下次冷启动仍会提示，避免用户忘配后续无入口；
            // 同时直接带用户去设置页，让"稍后配置"有明确入口（#193）
            setShowModelOnboarding(false);
            setShowSettings(true);
          }}
        />
      )}

      {/* Tool Create Confirm Modal - 动态工具创建确认 */}
      {toolCreateRequest && (
        <ToolCreateConfirmModal
          request={toolCreateRequest}
          onAllow={() => {
            ipcService.invoke(
              IPC_CHANNELS.SECURITY_TOOL_CREATE_RESPONSE,
              toolCreateRequest.id,
              true
            );
            setToolCreateRequest(null);
          }}
          onDeny={() => {
            ipcService.invoke(
              IPC_CHANNELS.SECURITY_TOOL_CREATE_RESPONSE,
              toolCreateRequest.id,
              false
            );
            setToolCreateRequest(null);
          }}
        />
      )}

      {/* Confirm Action Modal - confirm_action 工具弹窗 */}
      {confirmActionRequest && (
        <ConfirmActionModal
          request={confirmActionRequest}
          onClose={() => setConfirmActionRequest(null)}
        />
      )}

      <FolderTrustDialog
        evaluation={folderTrustEvaluation}
        isBusy={folderTrustBusy}
        onTrust={() => { void setFolderTrustDecision('trusted'); }}
        onBlock={() => { void setFolderTrustDecision('blocked'); }}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Memo Floater - Tauri 全局热键浮窗 */}
      <MemoFloater />

      {/* Background Task Panel - 后台任务浮动面板 */}
      <BackgroundSessionPanel />

      {/* Capture Panel - 知识库采集面板 */}
      {useAppStore((s) => s.showCapturePanel) && (
        <React.Suspense fallback={null}>
          <CapturePanel />
        </React.Suspense>
      )}

      {showAgentTeamPanel && currentSessionId && swarmActiveRunId && swarmActiveSessionId === currentSessionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-end">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowAgentTeamPanel(false)}
          />
          <div className="relative h-full">
            <React.Suspense fallback={null}>
              <AgentTeamPanel
                key={`${currentSessionId}:${swarmActiveRunId}`}
                sessionId={currentSessionId}
                runId={swarmActiveRunId}
                initialAgentId={selectedSwarmAgentId ?? undefined}
                onClose={() => setShowAgentTeamPanel(false)}
              />
            </React.Suspense>
          </div>
        </div>
      )}


      </div>
      </MemoryLearningProvider>
    </ErrorBoundary>
  );
};

export default App;
