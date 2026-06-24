// ============================================================================
// App - Main Application Component
// Linear-style UI refactor: Clean layout with task panel
// ============================================================================

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useAppStore } from './stores/appStore';
import { useWorkspaceModeStore } from './stores/workspaceModeStore';
import { useAuthStore, initializeAuthStore } from './stores/authStore';
import { initializeAgentRegistryStore } from './stores/agentRegistryStore';
import { useSessionStore } from './stores/sessionStore';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TitleBar } from './components/TitleBar';
import { UserQuestionModal } from './components/UserQuestionModal';
import { MCPElicitationModal } from './components/MCPElicitationModal';
import { AuthModal } from './components/AuthModal';
import { PasswordResetModal } from './components/PasswordResetModal';
import { ForceUpdateModal } from './components/ForceUpdateModal';
import { UpdateNotification } from './components/UpdateNotification';
import { isDesktopShellMode, isTauriMode } from './utils/platform';
// PermissionDialog moved to PermissionCard inline in ChatView
import { TaskPanel } from './components/TaskPanel';
import { SkillsPanel } from './components/SkillsPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { WorkspacePreviewPanel } from './components/WorkspacePreviewPanel';
import { ContextPanel } from './components/ContextPanel';
import { ReplayAuditPanel } from './components/features/audit/ReplayAuditPanel';
import { DevServerLauncher } from './components/LivePreview/DevServerLauncher';
import { WorkbenchTabs } from './components/WorkbenchTabs';
import { PromptManagerModal } from './components/features/prompts/PromptManagerModal';
import { BackgroundTaskPanel } from './components/features/background';
import { FullScreenPage } from './components/features/shared/FullScreenPage';
import { NativeDesktopSection } from './components/features/settings/sections/NativeDesktopSection';
import { ToolCreateConfirmModal, type ToolCreateRequest } from './components/ConfirmModal';
import { ModelOnboardingModal } from './components/onboarding/ModelOnboardingModal';
import { ConfirmActionModal } from './components/ConfirmActionModal';
import { useDisclosure } from './hooks/useDisclosure';
import { useMemoryEvents } from './hooks/useMemoryEvents';
import { MemoryLearningProvider } from './components/features/memory';
import { ToastContainer } from './components/Toast';
import { ProviderStatusNotice } from './components/ProviderStatusNotice';
import { BudgetAlertNotice } from './components/BudgetAlertNotice';
import { useTheme } from './hooks/useTheme';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTaskSync } from './hooks/useTaskSync';
import { useInAppValidationBridge } from './hooks/useInAppValidationBridge';
import { useBackgroundTaskSync } from './hooks/useBackgroundTaskSync';
import { Group as PanelGroup, Panel, Separator as ResizeHandle } from 'react-resizable-panels';
import { FileExplorerPanel } from './components/features/explorer/FileExplorerPanel';
import { MemoFloater } from './components/features/memo/MemoFloater';
import { useAppshots } from './hooks/useAppshots';
import { useComputerUsePip } from './hooks/useComputerUsePip';
import { useRendererBundleAutoReload } from './hooks/useRendererBundleAutoReload';
import { IPC_CHANNELS, IPC_DOMAINS, type NotificationClickedEvent, type NotificationShowEvent, type ToolCreateRequestEvent, type ConfirmActionRequest, type ContextHealthUpdateEvent } from '@shared/ipc';
import { postOsNotification, registerNotificationClick } from './utils/osNotification';
import type { AppSettings, ModelConfig, ModelProvider, UserQuestionRequest, MCPElicitationRequest, UpdateInfo, Message } from '@shared/contract';
import { UI, DEFAULT_PROVIDER, DEFAULT_MODEL, getDefaultModelForProvider, getProviderEndpointForProtocol } from '@shared/constants';
import { createLogger } from './utils/logger';
import ipcService from './services/ipcService';
import { useSwarmStore } from './stores/swarmStore';
import { useWorkflowStore } from './stores/workflowStore';
import { useBackgroundTaskStore } from './stores/backgroundTaskStore';
import { tauriCheckForUpdate } from './utils/tauriUpdater';
import { setSentryRendererContext } from './observability/sentryRenderer';

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
const DesignWorkspace = React.lazy(() => import('./components/design/DesignWorkspace').then((module) => ({
  default: module.DesignWorkspace,
})));
const DesignCanvasTab = React.lazy(() => import('./components/design/DesignCanvasTab').then((module) => ({
  default: module.DesignCanvasTab,
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
const BrowserSurfacePanel = React.lazy(() => import('./components/features/browser/BrowserSurfacePanel').then((module) => ({
  default: module.BrowserSurfacePanel,
})));
const ComputerUsePanel = React.lazy(() => import('./components/features/computerUse/ComputerUsePanel').then((module) => ({
  default: module.ComputerUsePanel,
})));
const InAppValidationPanel = React.lazy(() => import('./components/features/inAppValidation/InAppValidationPanel').then((module) => ({
  default: module.InAppValidationPanel,
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
  useAppshots(); // 挂载 Appshots 事件监听（热键截图 → composer）
  useComputerUsePip(); // computer-use 实时 PiP 窗（自主操作时悬浮显示截图）
  const {
    showSettings,
    setTaskPanelTab,
    showCronCenter,
    showTimeCapabilityCenter,
    setShowFileExplorer,
    showAgentTeamPanel,
    setShowAgentTeamPanel,
    selectedSwarmAgentId,
    showLab,
    showComputerUsePanel,
    showInAppValidationPanel,
    showKnowledgeMemoryPanel,
    showActivityPanel,
    setShowActivityPanel,
    showBrowserSurfacePanel,
    setShowBrowserSurfacePanel,
    setShowSettings,
    setLanguage,
    setOptionalUpdateInfo,
    optionalUpdateInfo,
    showOptionalUpdateModal,
    setShowOptionalUpdateModal,
    workbenchTabs,
    activeWorkbenchTab,
    openWorkbenchTab,
    syncTaskWorkbenchForActivity,
    pendingPermissionRequest,
    pendingPermissionSessionId,
    queuedPermissionRequests,
  } = useAppStore();

  // 响应式：窄屏先把横向空间让给聊天和右侧状态面板。
  const windowWidth = useWindowWidth();
  const isNarrowViewport = windowWidth < SIDEBAR_AUTO_COLLAPSE_WIDTH;
  const showWorkbench = windowWidth >= WORKBENCH_MIN_VISIBLE_WIDTH && workbenchTabs.length > 0;
  const isPreviewActive = typeof activeWorkbenchTab === 'string' && activeWorkbenchTab.startsWith('preview:');
  const showNarrowWorkbench =
    !showWorkbench &&
    workbenchTabs.length > 0 &&
    (isPreviewActive || activeWorkbenchTab === 'workspace-preview' || activeWorkbenchTab === 'audit');
  const appliedNarrowSidebarDefaultRef = useRef(false);

  const [userQuestion, setUserQuestion] = useState<UserQuestionRequest | null>(null);
  const [mcpElicitation, setMcpElicitation] = useState<MCPElicitationRequest | null>(null);

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

  // Auth store
  const { showAuthModal, showPasswordResetModal, isLoading: isAuthLoading } = useAuthStore();
  const sentryUserId = useAuthStore((state) => state.user?.id ?? null);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionTasks = useSessionStore((state) => state.sessionTasks);
  const todos = useSessionStore((state) => state.todos);
  const backgroundTasks = useBackgroundTaskStore((state) => state.tasks);
  const swarmIsRunning = useSwarmStore((state) => state.isRunning);
  const swarmExecutionPhase = useSwarmStore((state) => state.executionPhase);
  const swarmLaunchRequests = useSwarmStore((state) => state.launchRequests);
  const swarmPlanReviews = useSwarmStore((state) => state.planReviews);
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

  // Initialize agent registry store (custom .md agents 列表 + 热加载推送订阅)
  useEffect(() => {
    initializeAgentRegistryStore().catch((error) => {
      logger.error('Failed to initialize agent registry store', error);
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
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.USER_QUESTION_ASK,
      (request: UserQuestionRequest) => {
        logger.info('Received user question', { id: request.id });
        setUserQuestion(request);
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
        if (event.type === 'swarm:launch:requested' || event.type === 'swarm:started') {
          openWorkbenchTab('task', { source: 'auto' });
          setTaskPanelTab('monitor');
        }
        useSwarmStore.getState().handleEvent(event);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [openWorkbenchTab, setTaskPanelTab]);

  const hasOpenSessionTask = sessionTasks.some((task) =>
    task.status === 'pending' || task.status === 'in_progress'
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

  const renderWorkbenchContent = () => (
    <div className="flex flex-col h-full bg-zinc-900">
      <WorkbenchTabs />
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeWorkbenchTab === 'task' && <TaskPanel />}
        {activeWorkbenchTab === 'skills' && <SkillsPanel />}
        {activeWorkbenchTab === 'files' && (
          <FileExplorerPanel onClose={() => setShowFileExplorer(false)} />
        )}
        {activeWorkbenchTab === 'workspace-preview' && <WorkspacePreviewPanel />}
        {activeWorkbenchTab === 'context' && <ContextPanel />}
        {activeWorkbenchTab === 'audit' && <ReplayAuditPanel />}
        {activeWorkbenchTab === 'design-canvas' && (
          <React.Suspense fallback={null}>
            <DesignCanvasTab />
          </React.Suspense>
        )}
        {isPreviewActive && <PreviewPanel />}
      </div>
    </div>
  );

  return (
    <ErrorBoundary>
      <MemoryLearningProvider>
      <ToastContainer />
      <ProviderStatusNotice />
      <BudgetAlertNotice />
      <div className="h-screen flex flex-col bg-zinc-950 text-zinc-200">
        {/* Main Content - Three-column layout with integrated title bars */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Column: Sidebar with its own title bar - darker background */}
          {isStandard && !sidebarCollapsed && (
            <div className="flex flex-col w-60 bg-zinc-950">
              <Sidebar />
            </div>
          )}

          {/* Right Area: Chat + TaskPanel with shared title bar */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Right Title Bar */}
            <TitleBar />

            {/* Content Area */}
            <div className="flex-1 min-h-0 flex overflow-hidden">
              {showKnowledgeMemoryPanel ? (
                <React.Suspense fallback={null}>
                  <KnowledgeMemoryPanel />
                </React.Suspense>
              ) : showComputerUsePanel ? (
                <React.Suspense fallback={null}>
                  <ComputerUsePanel />
                </React.Suspense>
              ) : showInAppValidationPanel ? (
                <React.Suspense fallback={null}>
                  <InAppValidationPanel />
                </React.Suspense>
              ) : (
                <PanelGroup orientation="horizontal" className="flex-1 min-h-0" id="main-layout">
                  <Panel minSize="30" id="chat">
                    <div className="flex flex-col h-full min-h-0 min-w-0 bg-zinc-900">
                      {showNarrowWorkbench ? renderWorkbenchContent() : <ChatView />}
                    </div>
                  </Panel>

                  {showWorkbench && (
                    <ResizeHandle className="w-1 hover:w-1.5 bg-zinc-800 hover:bg-primary-500/50 transition-all cursor-col-resize" />
                  )}
                  {showWorkbench && (
                    <Panel defaultSize="32" minSize="15" maxSize="45" id="right-panel">
                      {renderWorkbenchContent()}
                    </Panel>
                  )}
                </PanelGroup>
              )}
            </div>
          </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <React.Suspense fallback={null}>
          <SettingsModal />
        </React.Suspense>
      )}

      {/* Prompt Manager Modal */}
      <PromptManagerModal />

      {/* V2-A: DevServerLauncher 自管 visibility，挂全局 */}
      <DevServerLauncher />

      {/* Design Workspace（Kun 借鉴：设计 tab）——全屏覆盖，Code 布局不变 */}
      {useWorkspaceModeStore((s) => s.workspaceMode) === 'design' && (
        <React.Suspense fallback={null}>
          <DesignWorkspace />
        </React.Suspense>
      )}

      {/* Lab Page */}
      {showLab && (
        <React.Suspense fallback={null}>
          <LabPage />
        </React.Suspense>
      )}

      {/* Workflow Page - 全屏工作流可视化 */}
      {dagPanelEnabled && showDAGPanel && (
        <React.Suspense fallback={null}>
          <WorkflowPanel onClose={() => setShowDAGPanel(false)} />
        </React.Suspense>
      )}



      {/* User Question Modal (Gen 3+) */}
      {userQuestion && (
        <UserQuestionModal
          request={userQuestion}
          onClose={() => setUserQuestion(null)}
        />
      )}

      {/* MCP Elicitation Modal */}
      {mcpElicitation && (
        <MCPElicitationModal
          request={mcpElicitation}
          onClose={() => setMcpElicitation(null)}
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

      {/* Memo Floater - Tauri 全局热键浮窗 */}
      <MemoFloater />

      {/* Background Task Panel - 后台任务浮动面板 */}
      <BackgroundTaskPanel />

      {/* Capture Panel - 知识库采集面板 */}
      {useAppStore((s) => s.showCapturePanel) && (
        <React.Suspense fallback={null}>
          <CapturePanel />
        </React.Suspense>
      )}

      {/* Cron Center - 定时任务中心 */}
      {showCronCenter && (
        <React.Suspense fallback={null}>
          <CronCenterPanel onClose={() => useAppStore.getState().setShowCronCenter(false)} />
        </React.Suspense>
      )}

      {showTimeCapabilityCenter && (
        <React.Suspense fallback={null}>
          <TimeCapabilityPanel onClose={() => useAppStore.getState().setShowTimeCapabilityCenter(false)} />
        </React.Suspense>
      )}

      {showActivityPanel && (
        <React.Suspense fallback={null}>
          <ActivityPanel onClose={() => setShowActivityPanel(false)} />
        </React.Suspense>
      )}

      {showBrowserSurfacePanel && (
        <React.Suspense fallback={null}>
          <BrowserSurfacePanel onClose={() => setShowBrowserSurfacePanel(false)} />
        </React.Suspense>
      )}

      {showAgentTeamPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-end">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowAgentTeamPanel(false)}
          />
          <div className="relative h-full">
            <React.Suspense fallback={null}>
              <AgentTeamPanel
                initialAgentId={selectedSwarmAgentId ?? undefined}
                onClose={() => setShowAgentTeamPanel(false)}
              />
            </React.Suspense>
          </div>
        </div>
      )}

      {/* Desktop Collector Panel - 全局记忆时间线面板 */}
      {useAppStore((s) => s.showDesktopPanel) && (
        <FullScreenPage testId="desktop-status-panel">
          <NativeDesktopSection
            variant="fullscreen"
            onClose={() => useAppStore.getState().setShowDesktopPanel(false)}
          />
        </FullScreenPage>
      )}


      </div>
      </MemoryLearningProvider>
    </ErrorBoundary>
  );
};

export default App;
