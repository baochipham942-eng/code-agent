// ============================================================================
// TitleBar - macOS Style Title Bar
// ============================================================================

import React from 'react';
import { useAppStore } from '../stores/appStore';
import { Settings, FolderOpen, PanelLeftClose, PanelLeft } from 'lucide-react';

export const TitleBar: React.FC = () => {
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    setShowSettings,
    setShowWorkspace,
    showWorkspace
  } = useAppStore();

  return (
    <div className="h-12 flex items-center justify-between px-4 border-b border-zinc-800 window-drag bg-zinc-900/80 backdrop-blur-sm">
      {/* Left: macOS traffic lights space + sidebar toggle */}
      <div className="flex items-center gap-2">
        {/* Space for macOS traffic lights */}
        <div className="w-16" />

        {/* Sidebar Toggle */}
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="window-no-drag p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
          title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        >
          {sidebarCollapsed ? (
            <PanelLeft className="w-4 h-4" />
          ) : (
            <PanelLeftClose className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Center: Title */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-300">Code Agent</span>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1">
        {/* Workspace Toggle */}
        <button
          onClick={() => setShowWorkspace(!showWorkspace)}
          className={`window-no-drag p-1.5 rounded-md transition-colors ${
            showWorkspace
              ? 'bg-blue-500/20 text-blue-400'
              : 'hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100'
          }`}
          title={showWorkspace ? 'Hide workspace' : 'Show workspace'}
        >
          <FolderOpen className="w-4 h-4" />
        </button>

        {/* Settings */}
        <button
          onClick={() => setShowSettings(true)}
          className="window-no-drag p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
