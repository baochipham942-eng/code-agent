// ============================================================================
// TitleBar - Right side title bar with workspace path and task panel toggle
// ============================================================================

import React from 'react';
import { useAppStore } from '../stores/appStore';
import { useDisclosure } from '../hooks/useDisclosure';
import { PanelLeftClose, PanelLeft, PanelRightClose, PanelRight, GitBranch, FlaskConical } from 'lucide-react';
import { IconButton } from './primitives';

export const TitleBar: React.FC = () => {
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    showTaskPanel,
    setShowTaskPanel,
    showDAGPanel,
    setShowDAGPanel,
    setShowLab,
    workingDirectory,
  } = useAppStore();

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

      {/* Right: Lab + DAG Panel Toggle + Task Panel Toggle */}
      <div className="flex items-center gap-1">
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
