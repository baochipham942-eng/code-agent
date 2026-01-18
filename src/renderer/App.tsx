// ============================================================================
// App - Main Application Component
// ============================================================================

import React, { useState, useEffect } from 'react';
import { useAppStore } from './stores/appStore';
import { useAuthStore, initializeAuthStore } from './stores/authStore';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { WorkspacePanel } from './components/WorkspacePanel';
import { TitleBar } from './components/TitleBar';
import { SettingsModal } from './components/SettingsModal';
import { GenerationBadge } from './components/GenerationBadge';
import { MemoryPanel } from './components/MemoryPanel';
import { ObservabilityPanel } from './components/ObservabilityPanel';
import { UserQuestionModal } from './components/UserQuestionModal';
import { AuthModal } from './components/AuthModal';
import { ForceUpdateModal } from './components/ForceUpdateModal';
import { PermissionModal } from './components/PermissionModal';
import { CloudTaskPanel } from './components/CloudTaskPanel';
import { useDisclosure } from './hooks/useDisclosure';
import { Activity, Brain, Cloud } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { UserQuestionRequest, UpdateInfo } from '@shared/types';

export const App: React.FC = () => {
  const {
    showSettings,
    showWorkspace,
    showPlanningPanel,
    setShowPlanningPanel,
    setShowSettings,
    currentGeneration,
    setLanguage,
    pendingPermissionRequest,
    setPendingPermissionRequest,
  } = useAppStore();

  const [userQuestion, setUserQuestion] = useState<UserQuestionRequest | null>(null);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [showCloudTaskPanel, setShowCloudTaskPanel] = useState(false);

  // 强制更新状态
  const [forceUpdateInfo, setForceUpdateInfo] = useState<UpdateInfo | null>(null);

  // Auth store
  const { showAuthModal } = useAuthStore();

  // 渐进披露 Hook
  const { isStandard, isAdvanced } = useDisclosure();

  // Debug: Check if electronAPI is available on mount
  useEffect(() => {
    console.log('[App] Mount - electronAPI available:', !!window.electronAPI);
    if (window.electronAPI) {
      console.log('[App] electronAPI methods:', Object.keys(window.electronAPI));
    }
  }, []);

  // Initialize auth store on mount
  useEffect(() => {
    initializeAuthStore().catch((error) => {
      console.error('[App] Failed to initialize auth store:', error);
    });
  }, []);

  // Load settings from backend on mount
  const { setModelConfig, setDisclosureLevel, setCurrentGeneration } = useAppStore();

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_GET);

        // 加载语言设置
        if (settings?.ui?.language) {
          setLanguage(settings.ui.language);
          console.log('[App] Loaded language setting:', settings.ui.language);
        }

        // 加载界面设置（渐进披露级别）
        if (settings?.ui?.disclosureLevel) {
          setDisclosureLevel(settings.ui.disclosureLevel);
          console.log('[App] Loaded disclosure level:', settings.ui.disclosureLevel);
        }

        // 加载代际选择
        if (settings?.generation?.default) {
          const generationId = settings.generation.default;
          console.log('[App] Loading generation:', generationId);
          // 从后端获取完整的 generation 对象
          const generation = await window.electronAPI?.invoke('generation:switch', generationId);
          if (generation) {
            setCurrentGeneration(generation);
            console.log('[App] Loaded generation:', generation.id);
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
            console.log('[App] Loaded model config for provider:', defaultProvider);
          }
        }
      } catch (error) {
        console.error('[App] Failed to load settings:', error);
      }
    };
    loadSettings();
  }, [setLanguage, setModelConfig, setDisclosureLevel, setCurrentGeneration]);

  // 应用启动时检查更新（强制更新检查）
  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        console.log('[App] Checking for updates on startup...');
        const updateInfo = await window.electronAPI?.invoke(IPC_CHANNELS.UPDATE_CHECK);

        if (updateInfo?.hasUpdate && updateInfo?.forceUpdate) {
          console.log('[App] Force update required:', updateInfo.latestVersion);
          setForceUpdateInfo(updateInfo);
        } else if (updateInfo?.hasUpdate) {
          console.log('[App] Optional update available:', updateInfo.latestVersion);
          // 可选更新不弹窗，用户可以在设置中查看
        } else {
          console.log('[App] App is up to date');
        }
      } catch (error) {
        console.error('[App] Failed to check for updates:', error);
      }
    };

    // 延迟检查，等待应用完全加载
    const timer = setTimeout(checkForUpdates, 2000);
    return () => clearTimeout(timer);
  }, []);

  // Check if observability panel is available (Advanced+ disclosure level)
  const isObservabilityAvailable = isAdvanced;

  // Check if Gen 5 (memory features available)
  const isMemoryAvailable = currentGeneration.id === 'gen5';

  // Listen for user question events (Gen 3+)
  useEffect(() => {
    const unsubscribe = window.electronAPI?.on(
      IPC_CHANNELS.USER_QUESTION_ASK,
      (request: UserQuestionRequest) => {
        console.log('[App] Received user question:', request.id);
        setUserQuestion(request);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

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

  // Memory panel toggle button (Gen 5 only)
  const MemoryToggle: React.FC = () => {
    if (!isMemoryAvailable) return null;

    return (
      <button
        onClick={() => setShowMemoryPanel(!showMemoryPanel)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
          showMemoryPanel
            ? 'bg-cyan-500/20 text-cyan-300'
            : 'text-zinc-500 hover:bg-zinc-800'
        }`}
        title="Toggle Memory Panel"
      >
        <Brain className="w-3.5 h-3.5" />
        <span>Memory</span>
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

  return (
    <div className="h-screen flex flex-col bg-zinc-900 text-zinc-100">
      {/* Title Bar for macOS */}
      <TitleBar />

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - 仅在 Standard+ 显示 */}
        {isStandard && <Sidebar />}

        {/* Chat Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Generation Badge with Observability Toggle */}
          <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isStandard && <GenerationBadge />}
            </div>
            <div className="flex items-center gap-2">
              {isObservabilityAvailable && <ObservabilityToggle />}
              {isMemoryAvailable && <MemoryToggle />}
              <CloudTaskToggle />
            </div>
          </div>

          {/* Chat View */}
          <ChatView />
        </div>

        {/* Observability Panel (Advanced+ disclosure) */}
        {showPlanningPanel && isObservabilityAvailable && <ObservabilityPanel />}

        {/* Memory Panel (Gen 5 only) */}
        {showMemoryPanel && isMemoryAvailable && <MemoryPanel isVisible={true} />}

        {/* Cloud Task Panel (Advanced mode) */}
        {showCloudTaskPanel && <CloudTaskPanel onClose={() => setShowCloudTaskPanel(false)} />}

        {/* Workspace Panel (Standard+ disclosure) */}
        {showWorkspace && isStandard && <WorkspacePanel />}
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

      {/* Permission Modal */}
      {pendingPermissionRequest && (
        <PermissionModal
          request={pendingPermissionRequest}
          onAllow={() => {
            window.electronAPI?.invoke(
              IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
              pendingPermissionRequest.id,
              'allow'
            );
            setPendingPermissionRequest(null);
          }}
          onDeny={() => {
            window.electronAPI?.invoke(
              IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
              pendingPermissionRequest.id,
              'deny'
            );
            setPendingPermissionRequest(null);
          }}
        />
      )}

      {/* Auth Modal */}
      {showAuthModal && <AuthModal />}

      {/* Force Update Modal - 强制更新，不可关闭 */}
      {forceUpdateInfo && <ForceUpdateModal updateInfo={forceUpdateInfo} />}
    </div>
  );
};

export default App;
