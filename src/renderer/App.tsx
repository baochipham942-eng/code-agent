// ============================================================================
// App - Main Application Component
// Linear-style UI refactor: Clean layout with task panel
// ============================================================================

import React, { useRef, useState, useEffect } from 'react';
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
import { EvalCenterPanel } from './components/features/evalCenter';
import { BackgroundTaskPanel } from './components/features/background';
import { CapturePanel } from './components/features/capture';
import { KnowledgeMemoryPanel } from './components/features/knowledge/KnowledgeMemoryPanel';
import { CronCenterPanel } from './components/features/cron/CronCenterPanel';
import TimeCapabilityPanel from './components/features/timeCapability/TimeCapabilityPanel';
import { AgentTeamPanel } from './components/features/agentTeam';
import { ActivityPanel } from './components/features/activity/ActivityPanel';
import { ComputerUsePanel } from './components/features/computerUse/ComputerUsePanel';
import { NativeDesktopSection } from './components/features/settings/sections/NativeDesktopSection';
import { ApiKeySetupModal, ToolCreateConfirmModal, type ToolCreateRequest } from './components/ConfirmModal';
import { ConfirmActionModal } from './components/ConfirmActionModal';
import { useDisclosure } from './hooks/useDisclosure';
import { useMemoryEvents } from './hooks/useMemoryEvents';
import { MemoryLearningProvider } from './components/features/memory';
import { ToastContainer } from './components/Toast';
import { useToastStore } from './hooks/useToast';
import { ProviderStatusNotice } from './components/ProviderStatusNotice';
import { useTheme } from './hooks/useTheme';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTaskSync } from './hooks/useTaskSync';
import { useBackgroundTaskSync } from './hooks/useBackgroundTaskSync';
import { Group as PanelGroup, Panel, Separator as ResizeHandle } from 'react-resizable-panels';
import { FileExplorerPanel } from './components/features/explorer/FileExplorerPanel';
import { MemoFloater } from './components/features/memo/MemoFloater';
import { IPC_CHANNELS, IPC_DOMAINS, type NotificationClickedEvent, type ToolCreateRequestEvent, type ConfirmActionRequest, type ContextHealthUpdateEvent } from '@shared/ipc';
import type { UserQuestionRequest, MCPElicitationRequest, UpdateInfo } from '@shared/contract';
import { UI, DEFAULT_PROVIDER, DEFAULT_MODEL } from '@shared/constants';
import { createLogger } from './utils/logger';
import ipcService from './services/ipcService';
import { useSwarmStore } from './stores/swarmStore';
import { tauriCheckForUpdate } from './utils/tauriUpdater';

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
    showEvalCenter,
    showComputerUsePanel,
    showKnowledgeMemoryPanel,
    showActivityPanel,
    setShowActivityPanel,
    setShowSettings,
    setLanguage,
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

  // API Key 配置引导弹窗
  const [showApiKeySetup, setShowApiKeySetup] = useState(false);

  // 工具创建确认弹窗
  const [toolCreateRequest, setToolCreateRequest] = useState<ToolCreateRequest | null>(null);

  // confirm_action 弹窗确认
  const [confirmActionRequest, setConfirmActionRequest] = useState<ConfirmActionRequest | null>(null);

  // Auth store
  const { showAuthModal, showPasswordResetModal } = useAuthStore();

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

  // Gen5+ Memory 事件监听
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

  // Initialize agent registry store (custom .md agents 列表 + 热加载推送订阅)
  useEffect(() => {
    initializeAgentRegistryStore().catch((error) => {
      logger.error('Failed to initialize agent registry store', error);
    });
  }, []);

  // Load settings from backend on mount
  const { setModelConfig, setDisclosureLevel, sidebarCollapsed, setSidebarCollapsed } = useAppStore();

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): SETTINGS 域 'get' action 返回 AppSettings，应抽 SettingsIpcMap 让 invokeDomain narrow
        const settings = await invokeDomain<any>(IPC_DOMAINS.SETTINGS, 'get');

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
          const defaultProvider = (settings.models.default || DEFAULT_PROVIDER) as import('@shared/contract').ModelProvider;
          const providerConfig = settings.models.providers?.[defaultProvider];

          if (providerConfig) {
            setModelConfig({
              provider: defaultProvider,
              model: providerConfig.model || DEFAULT_MODEL,
              apiKey: providerConfig.apiKey || '',
              baseUrl: providerConfig.baseUrl || '',
              temperature: providerConfig.temperature ?? 0.7,
              maxTokens: providerConfig.maxTokens ?? 4096,
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
        } else if (updateInfo?.hasUpdate) {
          logger.info('Optional update available', { latestVersion: updateInfo.latestVersion });
          // 可选更新不弹窗，用户可以在设置中查看
        } else {
          logger.info('App is up to date');
          // 启动时给一个轻量"已是最新版"反馈，2s 自动消失。只在本次冷启动触发一次。
          const v = updateInfo?.currentVersion;
          if (v) {
            useToastStore.getState().addToast('info', `已是最新版本 v${v}`, 2000);
          }
        }
      } catch (error) {
        logger.error('Failed to check for updates', error);
      }
    };

    // 延迟检查，等待应用完全加载
    const timer = setTimeout(checkForUpdates, UI.STARTUP_UPDATE_CHECK_DELAY);
    return () => clearTimeout(timer);
  }, []);

  // 首次启动检测 API Key 是否配置
  useEffect(() => {
    const checkApiKeyConfigured = async () => {
      try {
        const configured = await invokeDomain<boolean>(IPC_DOMAINS.SETTINGS, 'checkApiKeyConfigured');
        if (!configured) {
          logger.info('No API Key configured, showing setup modal');
          setShowApiKeySetup(true);
        }
      } catch (error) {
        logger.error('Failed to check API Key configuration', error);
      }
    };

    // 延迟检查，等待应用完全加载
    const timer = setTimeout(checkApiKeyConfigured, UI.STARTUP_API_KEY_CHECK_DELAY);
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
              ) : showEvalCenter ? (
                <EvalCenterPanel />
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
                    <Panel defaultSize="22" minSize="15" maxSize="45" id="right-panel">
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
      {showAuthModal && <AuthModal />}

      {/* Password Reset Modal - 设置新密码弹窗 */}
      {showPasswordResetModal && <PasswordResetModal />}

      {/* Force Update Modal - 强制更新，不可关闭 */}
      {isDesktopShellMode() && !isTauriMode() && forceUpdateInfo && <ForceUpdateModal updateInfo={forceUpdateInfo} />}

      {/* API Key Setup Modal - 首次启动引导 */}
      {showApiKeySetup && (
        <ApiKeySetupModal
          onSetup={() => {
            setShowApiKeySetup(false);
            setShowSettings(true);
          }}
          onSkip={() => setShowApiKeySetup(false)}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => useAppStore.getState().setShowDesktopPanel(false)}
          />
          <div
            data-testid="desktop-status-panel"
            className="relative w-full max-w-4xl h-[80vh] bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl overflow-hidden animate-fadeIn flex flex-col"
          >
            <NativeDesktopSection />
          </div>
        </div>
      )}


      </div>
      </MemoryLearningProvider>
    </ErrorBoundary>
  );
};

export default App;
