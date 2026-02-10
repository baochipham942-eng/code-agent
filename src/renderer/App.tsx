// ============================================================================
// App - Main Application Component
// Linear-style UI refactor: Clean layout with task panel
// ============================================================================

import React, { useState, useEffect } from 'react';
import { useAppStore } from './stores/appStore';
import { useAuthStore, initializeAuthStore } from './stores/authStore';
import { useSessionStore } from './stores/sessionStore';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TitleBar } from './components/TitleBar';
import { SettingsModal } from './components/SettingsModal';
import { UserQuestionModal } from './components/UserQuestionModal';
import { AuthModal } from './components/AuthModal';
import { PasswordResetModal } from './components/PasswordResetModal';
import { ForceUpdateModal } from './components/ForceUpdateModal';
import { PermissionDialog } from './components/PermissionDialog';
import { TaskPanel } from './components/TaskPanel';
import { SkillsPanel } from './components/SkillsPanel';
import { WorkflowPanel } from './components/features/workflow/WorkflowPanel';
import { LabPage } from './components/features/lab/LabPage';
import { EvalCenterPanel } from './components/features/evalCenter';
import { BackgroundTaskPanel } from './components/features/background';
import { CapturePanel } from './components/features/capture';
import { ApiKeySetupModal, ToolCreateConfirmModal, type ToolCreateRequest } from './components/ConfirmModal';
import { ConfirmActionModal } from './components/ConfirmActionModal';
import { useDisclosure } from './hooks/useDisclosure';
import { useMemoryEvents } from './hooks/useMemoryEvents';
import { useTheme } from './hooks/useTheme';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { Activity, Cloud, Zap, Sparkles, GitBranch } from 'lucide-react';
import { IPC_CHANNELS, type NotificationClickedEvent, type ToolCreateRequestEvent, type ConfirmActionRequest, type ContextHealthUpdateEvent } from '@shared/ipc';
import type { UserQuestionRequest, UpdateInfo } from '@shared/types';
import { UI, DEFAULT_PROVIDER, DEFAULT_MODEL } from '@shared/constants';
import { createLogger } from './utils/logger';

const logger = createLogger('App');

export const App: React.FC = () => {
  const {
    showSettings,
    showTaskPanel,
    setShowTaskPanel,
    showSkillsPanel,
    setShowSkillsPanel,
    showLab,
    setShowSettings,
    setLanguage,
  } = useAppStore();

  const [userQuestion, setUserQuestion] = useState<UserQuestionRequest | null>(null);

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
  const { isStandard, isAdvanced, dagPanelEnabled } = useDisclosure();
  const isObservabilityAvailable = isAdvanced; // 追踪面板在 Advanced+ 模式可用

  // Panel toggle states from appStore（用户偏好层：show* 表示用户手动开关）
  const {
    showPlanningPanel,
    setShowPlanningPanel,
    showDAGPanel,
    setShowDAGPanel,
  } = useAppStore();

  // Cloud task panel state
  const [showCloudTaskPanel, setShowCloudTaskPanel] = useState(false);
  const [showTaskListPanel, setShowTaskListPanel] = useState(false);

  // Theme Hook - 初始化主题系统
  useTheme();

  // 全局快捷键
  useKeyboardShortcuts();

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

  // Debug: Check if electronAPI is available on mount
  useEffect(() => {
    logger.debug('Mount - electronAPI available', { available: !!window.electronAPI });
    if (window.electronAPI) {
      logger.debug('electronAPI methods', { methods: Object.keys(window.electronAPI) });
    }
  }, []);

  // Initialize auth store on mount
  useEffect(() => {
    initializeAuthStore().catch((error) => {
      logger.error('Failed to initialize auth store', error);
    });
  }, []);

  // Load settings from backend on mount
  const { setModelConfig, setDisclosureLevel, setCurrentGeneration, sidebarCollapsed } = useAppStore();

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_GET);

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

        // 加载代际选择
        if (settings?.generation?.default) {
          const generationId = settings.generation.default;
          logger.info('Loading generation', { generationId });
          // 从后端获取完整的 generation 对象
          const generation = await window.electronAPI?.invoke('generation:switch', generationId);
          if (generation) {
            setCurrentGeneration(generation);
            logger.info('Loaded generation', { generationId: generation.id });
          }
        }

        // 加载模型配置
        if (settings?.models) {
          const defaultProvider = (settings.models.default || DEFAULT_PROVIDER) as import('@shared/types').ModelProvider;
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
  }, [setLanguage, setModelConfig, setDisclosureLevel, setCurrentGeneration]);

  // 应用启动时检查更新（强制更新检查）
  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        logger.info('Checking for updates on startup');
        const updateInfo = await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_CHECK);

        if (updateInfo?.hasUpdate && updateInfo?.forceUpdate) {
          logger.info('Force update required', { latestVersion: updateInfo.latestVersion });
          setForceUpdateInfo(updateInfo);
        } else if (updateInfo?.hasUpdate) {
          logger.info('Optional update available', { latestVersion: updateInfo.latestVersion });
          // 可选更新不弹窗，用户可以在设置中查看
        } else {
          logger.info('App is up to date');
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
        const configured = await window.electronAPI?.invoke(IPC_CHANNELS.SECURITY_CHECK_API_KEY_CONFIGURED);
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
    const unsubscribe = window.electronAPI?.on(
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
    const unsubscribe = window.electronAPI?.on(
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

  // Listen for notification click events (切换到对应会话)
  useEffect(() => {
    const unsubscribe = window.electronAPI?.on(
      IPC_CHANNELS.NOTIFICATION_CLICKED,
      (event: NotificationClickedEvent) => {
        logger.info('Notification clicked, switching to session', { sessionId: event.sessionId });
        useSessionStore.getState().switchSession(event.sessionId);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Listen for confirm_action events (Gen 3+)
  useEffect(() => {
    const unsubscribe = window.electronAPI?.on(
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
    const unsubscribe = window.electronAPI?.on(
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

  // Observability panel toggle button (Advanced+ mode)
  const ObservabilityToggle: React.FC = () => {
    if (!isObservabilityAvailable) return null;

    return (
      <button
        onClick={() => setShowPlanningPanel(!showPlanningPanel)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
          showPlanningPanel
            ? 'bg-indigo-500/20 text-indigo-300'
            : 'text-zinc-500 hover:bg-zinc-800'
        }`}
        title="执行追踪面板"
      >
        <Activity className="w-3.5 h-3.5" />
        <span>追踪</span>
      </button>
    );
  };

  // DAG 可视化面板切换按钮 (Advanced+ mode)
  const DAGToggle: React.FC = () => {
    if (!dagPanelEnabled) return null;

    return (
      <button
        onClick={() => setShowDAGPanel(!showDAGPanel)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
          showDAGPanel
            ? 'bg-blue-500/20 text-blue-300'
            : 'text-zinc-500 hover:bg-zinc-800'
        }`}
        title="任务执行图"
      >
        <GitBranch className="w-3.5 h-3.5" />
        <span>DAG</span>
      </button>
    );
  };


  // Cloud task panel toggle button (Advanced mode)
  const CloudTaskToggle: React.FC = () => {
    if (!isAdvanced) return null;

    return (
      <button
        onClick={() => setShowCloudTaskPanel(!showCloudTaskPanel)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
          showCloudTaskPanel
            ? 'bg-sky-500/20 text-sky-300'
            : 'text-zinc-500 hover:bg-zinc-800'
        }`}
        title="云端任务"
      >
        <Cloud className="w-3.5 h-3.5" />
        <span>云端任务</span>
      </button>
    );
  };

  // Local task list panel toggle button (Standard+ mode)
  const TaskListToggle: React.FC = () => {
    if (!isStandard) return null;

    return (
      <button
        onClick={() => setShowTaskListPanel(!showTaskListPanel)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
          showTaskListPanel
            ? 'bg-yellow-500/20 text-yellow-300'
            : 'text-zinc-500 hover:bg-zinc-800'
        }`}
        title="多任务面板"
      >
        <Zap className="w-3.5 h-3.5" />
        <span>任务</span>
      </button>
    );
  };

  // Skills panel toggle button (Standard+ mode)
  const SkillsToggle: React.FC = () => {
    if (!isStandard) return null;

    return (
      <button
        onClick={() => setShowSkillsPanel(!showSkillsPanel)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
          showSkillsPanel
            ? 'bg-purple-500/20 text-purple-300'
            : 'text-zinc-500 hover:bg-zinc-800'
        }`}
        title="Skills 面板"
      >
        <Sparkles className="w-3.5 h-3.5" />
        <span>Skills</span>
      </button>
    );
  };

  return (
    <ErrorBoundary>
      <div className="h-screen flex flex-col bg-void text-zinc-100">
        {/* Main Content - Three-column layout with integrated title bars */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Column: Sidebar with its own title bar - darker background */}
          {isStandard && !sidebarCollapsed && (
            <div className="flex flex-col w-60 bg-[#141417]">
              {/* Sidebar Title Bar - macOS traffic lights space */}
              <div className="h-12 flex items-center px-3 window-drag">
                <div className="w-[68px]" /> {/* Space for macOS traffic lights */}
              </div>
              <Sidebar />
            </div>
          )}

          {/* Right Area: Chat + TaskPanel with shared title bar */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Right Title Bar */}
            <TitleBar />

            {/* Content Area */}
            <div className="flex-1 flex overflow-hidden">
              {/* Chat Area - flexible width, lighter background */}
              <div className="flex-1 flex flex-col min-w-0 bg-[#1c1c21]">
                <ChatView />
              </div>

              {/* Task Panel - 320px fixed width, right side */}
              {showTaskPanel && <TaskPanel />}

              {/* Skills Panel - 右侧面板，显示当前会话的 Skills */}
              {showSkillsPanel && (
                <SkillsPanel onClose={() => setShowSkillsPanel(false)} />
              )}
            </div>
          </div>
        </div>

      {/* Settings Modal */}
      {showSettings && <SettingsModal />}

      {/* Lab Page */}
      {showLab && <LabPage />}

      {/* Workflow Page - 全屏工作流可视化 */}
      {dagPanelEnabled && showDAGPanel && (
        <WorkflowPanel onClose={() => setShowDAGPanel(false)} />
      )}

      {/* EvalCenter - 评测中心（合并评测 + 遥测） */}
      <EvalCenterPanel />

      {/* User Question Modal (Gen 3+) */}
      {userQuestion && (
        <UserQuestionModal
          request={userQuestion}
          onClose={() => setUserQuestion(null)}
        />
      )}

      {/* Permission Dialog - 新版多级审批组件 */}
      <PermissionDialog />

      {/* Auth Modal */}
      {showAuthModal && <AuthModal />}

      {/* Password Reset Modal - 设置新密码弹窗 */}
      {showPasswordResetModal && <PasswordResetModal />}

      {/* Force Update Modal - 强制更新，不可关闭 */}
      {forceUpdateInfo && <ForceUpdateModal updateInfo={forceUpdateInfo} />}

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
            window.electronAPI?.invoke(
              IPC_CHANNELS.SECURITY_TOOL_CREATE_RESPONSE,
              toolCreateRequest.id,
              true
            );
            setToolCreateRequest(null);
          }}
          onDeny={() => {
            window.electronAPI?.invoke(
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

      {/* Background Task Panel - 后台任务浮动面板 */}
      <BackgroundTaskPanel />

      {/* Capture Panel - 知识库采集面板 */}
      {useAppStore((s) => s.showCapturePanel) && <CapturePanel />}
      </div>
    </ErrorBoundary>
  );
};

export default App;
