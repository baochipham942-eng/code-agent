// ============================================================================
// TitleBar - Linear-style Title Bar with Gen selector, workspace path, session title
// ============================================================================

import React from 'react';
import { useAppStore } from '../stores/appStore';
import { PanelLeftClose, PanelLeft, LayoutGrid } from 'lucide-react';
import { GenerationBadge } from './GenerationBadge';
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
    <div className="h-12 flex items-center justify-between px-4 border-b border-white/[0.06] window-drag bg-transparent backdrop-blur-sm">
      {/* Left: macOS traffic lights space + sidebar toggle + workspace path */}
      <div className="flex items-center gap-3">
        {/* Space for macOS traffic lights */}
        <div className="w-16" />

        {/* Sidebar Toggle */}
        <IconButton
          icon={sidebarCollapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          variant="default"
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

      {/* Right: Task Panel Toggle + Gen Badge */}
      <div className="flex items-center gap-3">
        {/* Task Panel Toggle - outline style, no background */}
        <IconButton
          icon={<LayoutGrid className="w-4 h-4" />}
          aria-label={showTaskPanel ? 'Hide task panel' : 'Show task panel'}
          onClick={() => setShowTaskPanel(!showTaskPanel)}
          variant="outline"
          size="md"
          windowNoDrag
          className={showTaskPanel ? '!border-white/30 !text-zinc-200' : ''}
        />

        {/* Generation Badge - text only */}
        <div className="window-no-drag">
          <GenerationBadge />
        </div>
      </div>
    </div>
  );
};
