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
import { ApiKeySetupModal, ToolCreateConfirmModal, type ToolCreateRequest } from './components/ConfirmModal';
import { ConfirmActionModal } from './components/ConfirmActionModal';
import { useDisclosure } from './hooks/useDisclosure';
import { useMemoryEvents } from './hooks/useMemoryEvents';
import { useTheme } from './hooks/useTheme';
import { IPC_CHANNELS, type NotificationClickedEvent, type ToolCreateRequestEvent, type ConfirmActionRequest } from '@shared/ipc';
import type { UserQuestionRequest, UpdateInfo } from '@shared/types';
import { UI } from '@shared/constants';
import { createLogger } from './utils/logger';

const logger = createLogger('App');

export const App: React.FC = () => {
  const {
    showSettings,
    showTaskPanel,
    setShowTaskPanel,
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

  // 渐进披露 Hook
  const { isStandard } = useDisclosure();

  // Theme Hook - 初始化主题系统
  useTheme();

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
          const defaultProvider = (settings.models.default || 'deepseek') as import('@shared/types').ModelProvider;
          const providerConfig = settings.models.providers?.[defaultProvider];

          if (providerConfig) {
            setModelConfig({
              provider: defaultProvider,
              model: providerConfig.model || 'deepseek-chat',
              apiKey: providerConfig.apiKey || '',
              baseUrl: providerConfig.baseUrl || 'https://api.deepseek.com',
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

  return (
    <ErrorBoundary>
      <div className="h-screen flex flex-col bg-void text-zinc-100">
        {/* Title Bar for macOS - includes Gen selector, workspace path, session title */}
        <TitleBar />

        {/* Main Content - Linear-style three-column layout */}
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar - 240px fixed width, collapsible */}
          {isStandard && !sidebarCollapsed && <Sidebar />}

          {/* Chat Area - flexible width */}
          <div className="flex-1 flex flex-col min-w-0">
            <ChatView />
          </div>

          {/* Task Panel - 320px fixed width, right side */}
          {showTaskPanel && <TaskPanel onClose={() => setShowTaskPanel(false)} />}
        </div>

      {/* Settings Modal */}
      {showSettings && <SettingsModal />}

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
      </div>
    </ErrorBoundary>
  );
};

export default App;
