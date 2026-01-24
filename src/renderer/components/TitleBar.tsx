// ============================================================================
// TitleBar - Right side title bar with workspace path and task panel toggle
// ============================================================================

import React from 'react';
import { useAppStore } from '../stores/appStore';
import { PanelLeftClose, PanelLeft, ChevronRight } from 'lucide-react';
import { IconButton } from './primitives';

export const TitleBar: React.FC = () => {
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    showTaskPanel,
    setShowTaskPanel,
    workingDirectory,
  } = useAppStore();

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

      {/* Right: Task Panel Toggle - ghost style with chevron, aligned with section chevrons */}
      <button
        onClick={() => setShowTaskPanel(!showTaskPanel)}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs transition-colors window-no-drag ${
          showTaskPanel
            ? 'text-zinc-300'
            : 'text-zinc-500 hover:text-zinc-300'
        }`}
      >
        <span>任务信息</span>
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showTaskPanel ? 'rotate-180' : ''}`} />
      </button>
    </div>
  );
};
