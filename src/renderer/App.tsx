// ============================================================================
// App - Main Application Component
// Linear-style UI refactor: Clean layout with task panel
// ============================================================================

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useAppStore } from './stores/appStore';
import { useAuthStore, initializeAuthStore } from './stores/authStore';
import { initializeAgentRegistryStore } from './stores/agentRegistryStore';
import { useSessionStore } from './stores/sessionStore';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TitleBar } from './components/TitleBar';
import { SettingsModal } from './components/SettingsModal';
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
import { DevServerLauncher } from './components/LivePreview/DevServerLauncher';
import { WorkbenchTabs } from './components/WorkbenchTabs';
import { WorkflowPanel } from './components/features/workflow/WorkflowPanel';
import { LabPage } from './components/features/lab/LabPage';
import { PromptManagerModal } from './components/features/prompts/PromptManagerModal';
import { BackgroundTaskPanel } from './components/features/background';
import { CapturePanel } from './components/features/capture';
import { KnowledgeMemoryPanel } from './components/features/knowledge/KnowledgeMemoryPanel';
import { CronCenterPanel } from './components/features/cron/CronCenterPanel';
import TimeCapabilityPanel from './components/features/timeCapability/TimeCapabilityPanel';
import { AgentTeamPanel } from './components/features/agentTeam';
import { ActivityPanel } from './components/features/activity/ActivityPanel';
import { BrowserSurfacePanel } from './components/features/browser/BrowserSurfacePanel';
import { ComputerUsePanel } from './components/features/computerUse/ComputerUsePanel';
import { InAppValidationPanel } from './components/features/inAppValidation/InAppValidationPanel';
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
import { IPC_CHANNELS, IPC_DOMAINS, type NotificationClickedEvent, type ToolCreateRequestEvent, type ConfirmActionRequest, type ContextHealthUpdateEvent } from '@shared/ipc';
import type { AppSettings, ModelConfig, ModelProvider, UserQuestionRequest, MCPElicitationRequest, UpdateInfo } from '@shared/contract';
import { UI, DEFAULT_PROVIDER, DEFAULT_MODEL, getProviderEndpointForProtocol } from '@shared/constants';
import { createLogger } from './utils/logger';
import ipcService from './services/ipcService';
import { useSwarmStore } from './stores/swarmStore';
import { useWorkflowStore } from './stores/workflowStore';
import { tauriCheckForUpdate } from './utils/tauriUpdater';
import { setSentryRendererContext } from './observability/sentryRenderer';

const logger = createLogger('App');
const SIDEBAR_AUTO_COLLAPSE_WIDTH = 1180;
const WORKBENCH_MIN_VISIBLE_WIDTH = 900;

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
  } = useAppStore();

  // 响应式：窄屏先把横向空间让给聊天和右侧状态面板。
  const windowWidth = useWindowWidth();
  const isNarrowViewport = windowWidth < SIDEBAR_AUTO_COLLAPSE_WIDTH;
  const showWorkbench = windowWidth >= WORKBENCH_MIN_VISIBLE_WIDTH && workbenchTabs.length > 0;
  const isPreviewActive = typeof activeWorkbenchTab === 'string' && activeWorkbenchTab.startsWith('preview:');
  const showNarrowWorkbench =
    !showWorkbench &&
    workbenchTabs.length > 0 &&
    (isPreviewActive || activeWorkbenchTab === 'workspace-preview');
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
  const sentrySessionId = useSessionStore((state) => state.currentSessionId);

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

  // 全局快捷键（含 ⌘⇧C compact 触发）
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
    setSentryRendererContext({ sessionId: sentrySessionId, userId: sentryUserId });
  }, [sentrySessionId, sentryUserId]);

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
            const model = providerConfig.model || DEFAULT_MODEL;
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
          openWorkbenchTab('task');
          setTaskPanelTab('monitor');
        }
        useSwarmStore.getState().handleEvent(event);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [openWorkbenchTab, setTaskPanelTab]);

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
        {isPreviewActive && <PreviewPanel />}
      </div>
    </div>
  );

  return (
    <ErrorBoundary>
      <MemoryLearningProvider>
      <ToastContainer />
      <ProviderStatusNotice />
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
                <KnowledgeMemoryPanel />
              ) : showComputerUsePanel ? (
                <ComputerUsePanel />
              ) : showInAppValidationPanel ? (
                <InAppValidationPanel />
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
      {showSettings && <SettingsModal />}

      {/* Prompt Manager Modal */}
      <PromptManagerModal />

      {/* V2-A: DevServerLauncher 自管 visibility，挂全局 */}
      <DevServerLauncher />

      {/* Lab Page */}
      {showLab && <LabPage />}

      {/* Workflow Page - 全屏工作流可视化 */}
      {dagPanelEnabled && showDAGPanel && (
        <WorkflowPanel onClose={() => setShowDAGPanel(false)} />
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
      {useAppStore((s) => s.showCapturePanel) && <CapturePanel />}

      {/* Cron Center - 定时任务中心 */}
      {showCronCenter && (
        <CronCenterPanel onClose={() => useAppStore.getState().setShowCronCenter(false)} />
      )}

      {showTimeCapabilityCenter && (
        <TimeCapabilityPanel onClose={() => useAppStore.getState().setShowTimeCapabilityCenter(false)} />
      )}

      {showActivityPanel && (
        <ActivityPanel onClose={() => setShowActivityPanel(false)} />
      )}

      {showBrowserSurfacePanel && (
        <BrowserSurfacePanel onClose={() => setShowBrowserSurfacePanel(false)} />
      )}

      {showAgentTeamPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-end">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowAgentTeamPanel(false)}
          />
          <div className="relative h-full">
            <AgentTeamPanel
              initialAgentId={selectedSwarmAgentId ?? undefined}
              onClose={() => setShowAgentTeamPanel(false)}
            />
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
