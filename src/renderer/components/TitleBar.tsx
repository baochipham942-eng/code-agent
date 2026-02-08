// ============================================================================
// TitleBar - Right side title bar with workspace path and task panel toggle
// ============================================================================

import React from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useDisclosure } from '../hooks/useDisclosure';
import { PanelLeftClose, PanelLeft, PanelRightClose, PanelRight, GitBranch, FlaskConical, Activity } from 'lucide-react';
import { IconButton } from './primitives';

// 奶酪图标组件
const CheeseIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12l10-9 10 9" />
    <path d="M2 12h20v9H2z" />
    <circle cx="7" cy="16" r="1.5" fill="currentColor" />
    <circle cx="12" cy="14" r="1" fill="currentColor" />
    <circle cx="16" cy="17" r="1.5" fill="currentColor" />
  </svg>
);

export const TitleBar: React.FC = () => {
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    showTaskPanel,
    setShowTaskPanel,
    showDAGPanel,
    setShowDAGPanel,
    setShowLab,
    setShowEvaluation,
    showTelemetry,
    setShowTelemetry,
    workingDirectory,
  } = useAppStore();

  // 获取当前会话 ID
  const currentSessionId = useSessionStore((state) => state.currentSessionId);

  // DAG 面板权限检查
  const { dagPanelEnabled } = useDisclosure();

  // Get workspace name from path
  const getWorkspaceName = (path: string | null): string => {
    if (!path) return '';
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
  };

  const workspaceName = getWorkspaceName(workingDirectory);

  return (
    <div className="h-12 flex items-center justify-between px-4 border-b border-white/[0.06] window-drag bg-transparent backdrop-blur-sm relative z-30">
      {/* Left: sidebar toggle + workspace path */}
      <div className="flex items-center gap-3">
        {/* Sidebar Toggle */}
        <IconButton
          icon={sidebarCollapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          variant="ghost"
          size="md"
          windowNoDrag
        />

        {/* Workspace Path */}
        {workspaceName && (
          <span className="text-xs text-zinc-500 hidden sm:inline" title={workingDirectory || ''}>
            {workspaceName}
          </span>
        )}
      </div>

      {/* Right: Evaluation + Lab + DAG Panel Toggle + Task Panel Toggle */}
      <div className="flex items-center gap-1">
        {/* Evaluation Button (奶酪图标) */}
        {currentSessionId && (
          <IconButton
            icon={<CheeseIcon className="w-4 h-4" />}
            aria-label="会话评测"
            onClick={() => setShowEvaluation?.(true)}
            variant="ghost"
            size="md"
            windowNoDrag
            className="text-amber-400/70 hover:text-amber-400"
          />
        )}

        {/* Telemetry Button */}
        {currentSessionId && (
          <IconButton
            icon={<Activity className="w-4 h-4" />}
            aria-label="会话遥测"
            onClick={() => setShowTelemetry(!showTelemetry)}
            variant="ghost"
            size="md"
            windowNoDrag
            className={showTelemetry ? 'text-cyan-400' : 'text-cyan-400/70 hover:text-cyan-400'}
          />
        )}

        {/* Lab Button */}
        <IconButton
          icon={<FlaskConical className="w-4 h-4" />}
          aria-label="实验室"
          onClick={() => setShowLab(true)}
          variant="ghost"
          size="md"
          windowNoDrag
          className="text-emerald-400/70 hover:text-emerald-400"
        />

        {/* DAG Panel Toggle (Advanced+ mode) */}
        {dagPanelEnabled && (
          <IconButton
            icon={<GitBranch className="w-4 h-4" />}
            aria-label={showDAGPanel ? '隐藏任务执行图' : '显示任务执行图'}
            onClick={() => setShowDAGPanel(!showDAGPanel)}
            variant="ghost"
            size="md"
            windowNoDrag
            className={showDAGPanel ? 'text-blue-400' : ''}
          />
        )}

        {/* Task Panel Toggle */}
        <IconButton
          icon={showTaskPanel ? <PanelRightClose className="w-4 h-4" /> : <PanelRight className="w-4 h-4" />}
          aria-label={showTaskPanel ? 'Hide task panel' : 'Show task panel'}
          onClick={() => setShowTaskPanel(!showTaskPanel)}
          variant="ghost"
          size="md"
          windowNoDrag
        />
      </div>
    </div>
  );
};
