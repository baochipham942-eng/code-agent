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
import { PlanningPanel } from './components/PlanningPanel';
import { FindingsPanel } from './components/FindingsPanel';
import { ErrorsPanel } from './components/ErrorsPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { UserQuestionModal } from './components/UserQuestionModal';
import { AuthModal } from './components/AuthModal';
import { UpdateNotification } from './components/UpdateNotification';
import { useDisclosure } from './hooks/useDisclosure';
import { Target, Lightbulb, AlertOctagon, Layers, Brain } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { UserQuestionRequest } from '@shared/types';

// Planning panel tab type
type PlanningTab = 'plan' | 'findings' | 'errors';

export const App: React.FC = () => {
  const {
    showSettings,
    showWorkspace,
    showPlanningPanel,
    setShowPlanningPanel,
    setShowSettings,
    currentGeneration,
    taskPlan,
    findings,
    errors,
    setTaskPlan,
    setFindings,
    setErrors,
    setLanguage,
  } = useAppStore();

  const [activePlanningTab, setActivePlanningTab] = useState<PlanningTab>('plan');
  const [userQuestion, setUserQuestion] = useState<UserQuestionRequest | null>(null);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);

  // Auth store
  const { showAuthModal } = useAuthStore();

  // 渐进披露 Hook
  const { isStandard, isAdvanced, isExpert, getLevelName, upgradeLevel } = useDisclosure();

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

  // Load language setting from backend on mount
  useEffect(() => {
    const loadLanguageSetting = async () => {
      try {
        const settings = await window.electronAPI?.invoke(IPC_CHANNELS.SETTINGS_GET);
        if (settings?.ui?.language) {
          setLanguage(settings.ui.language);
          console.log('[App] Loaded language setting:', settings.ui.language);
        }
      } catch (error) {
        console.error('[App] Failed to load language setting:', error);
      }
    };
    loadLanguageSetting();
  }, [setLanguage]);

  // Check if Gen 3+ (persistent planning available)
  const isPlanningAvailable =
    (currentGeneration.id === 'gen3' || currentGeneration.id === 'gen4') && isAdvanced;

  // Check if Gen 5 (memory features available)
  const isMemoryAvailable = currentGeneration.id === 'gen5';

  // Listen for planning events from main process
  useEffect(() => {
    if (!isPlanningAvailable) return;

    const unsubscribe = window.electronAPI?.on(
      IPC_CHANNELS.PLANNING_EVENT,
      (event) => {
        if (event.data.plan !== undefined) {
          setTaskPlan(event.data.plan);
        }
        if (event.data.findings !== undefined) {
          setFindings(event.data.findings);
        }
        if (event.data.errors !== undefined) {
          setErrors(event.data.errors);
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [isPlanningAvailable, setTaskPlan, setFindings, setErrors]);

  // Fetch initial planning state
  useEffect(() => {
    if (!isPlanningAvailable) return;

    const fetchPlanningState = async () => {
      try {
        const state = await window.electronAPI?.invoke(
          IPC_CHANNELS.PLANNING_GET_STATE
        );
        if (state) {
          setTaskPlan(state.plan);
          setFindings(state.findings);
          setErrors(state.errors);
        }
      } catch (error) {
        console.error('Failed to fetch planning state:', error);
      }
    };

    fetchPlanningState();
  }, [isPlanningAvailable, setTaskPlan, setFindings, setErrors]);

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

  // Planning panel toggle button
  const PlanningToggle: React.FC = () => {
    if (!isPlanningAvailable) return null;

    const hasContent = taskPlan || findings.length > 0 || errors.length > 0;
    const errorCount = errors.filter((e) => e.count >= 3).length;

    return (
      <button
        onClick={() => setShowPlanningPanel(!showPlanningPanel)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
          showPlanningPanel
            ? 'bg-purple-500/20 text-purple-300'
            : hasContent
            ? 'text-purple-400 hover:bg-zinc-800'
            : 'text-zinc-500 hover:bg-zinc-800'
        }`}
        title="Toggle Planning Panel"
      >
        <Target className="w-3.5 h-3.5" />
        <span>Plan</span>
        {errorCount > 0 && (
          <span className="px-1 py-0.5 bg-red-500/20 text-red-400 rounded text-xs">
            {errorCount}
          </span>
        )}
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

  // Planning tab bar
  const PlanningTabBar: React.FC = () => (
    <div className="flex border-b border-zinc-800">
      <button
        onClick={() => setActivePlanningTab('plan')}
        className={`flex items-center gap-1.5 px-3 py-2 text-xs transition-colors ${
          activePlanningTab === 'plan'
            ? 'text-purple-400 border-b-2 border-purple-400 -mb-px'
            : 'text-zinc-400 hover:text-zinc-200'
        }`}
      >
        <Target className="w-3.5 h-3.5" />
        Plan
        {taskPlan && (
          <span className="text-zinc-500">
            ({taskPlan.metadata.completedSteps}/{taskPlan.metadata.totalSteps})
          </span>
        )}
      </button>
      <button
        onClick={() => setActivePlanningTab('findings')}
        className={`flex items-center gap-1.5 px-3 py-2 text-xs transition-colors ${
          activePlanningTab === 'findings'
            ? 'text-yellow-400 border-b-2 border-yellow-400 -mb-px'
            : 'text-zinc-400 hover:text-zinc-200'
        }`}
      >
        <Lightbulb className="w-3.5 h-3.5" />
        Findings
        {findings.length > 0 && (
          <span className="text-zinc-500">({findings.length})</span>
        )}
      </button>
      <button
        onClick={() => setActivePlanningTab('errors')}
        className={`flex items-center gap-1.5 px-3 py-2 text-xs transition-colors ${
          activePlanningTab === 'errors'
            ? 'text-red-400 border-b-2 border-red-400 -mb-px'
            : 'text-zinc-400 hover:text-zinc-200'
        }`}
      >
        <AlertOctagon className="w-3.5 h-3.5" />
        Errors
        {errors.length > 0 && (
          <span className="text-zinc-500">({errors.length})</span>
        )}
      </button>
    </div>
  );

  // Render active planning panel
  const renderPlanningPanel = () => {
    switch (activePlanningTab) {
      case 'plan':
        return <PlanningPanel plan={taskPlan} />;
      case 'findings':
        return <FindingsPanel findings={findings} />;
      case 'errors':
        return <ErrorsPanel errors={errors} />;
    }
  };

  // 披露级别指示器组件
  const DisclosureLevelIndicator: React.FC = () => (
    <button
      onClick={() => setShowSettings(true)}
      className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
      title="Change disclosure level"
    >
      <Layers className="w-3.5 h-3.5" />
      <span>{getLevelName()}</span>
    </button>
  );

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
          {/* Generation Badge with Planning Toggle */}
          <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isStandard && <GenerationBadge />}
              <DisclosureLevelIndicator />
            </div>
            <div className="flex items-center gap-2">
              {isPlanningAvailable && <PlanningToggle />}
              {isMemoryAvailable && <MemoryToggle />}
            </div>
          </div>

          {/* Chat View */}
          <ChatView />
        </div>

        {/* Planning Panel (Gen 3+ only, Advanced+ disclosure) */}
        {showPlanningPanel && isPlanningAvailable && (
          <div className="flex flex-col border-l border-zinc-800 bg-zinc-900/50">
            <PlanningTabBar />
            {renderPlanningPanel()}
          </div>
        )}

        {/* Memory Panel (Gen 5 only) */}
        {showMemoryPanel && isMemoryAvailable && <MemoryPanel isVisible={true} />}

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

      {/* Auth Modal */}
      {showAuthModal && <AuthModal />}

      {/* Update Notification */}
      <UpdateNotification position="top" />
    </div>
  );
};

export default App;
