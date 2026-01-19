// ============================================================================
// TitleBar - macOS Style Title Bar
// ============================================================================

import React from 'react';
import { useAppStore } from '../stores/appStore';
import { Settings, FolderOpen, PanelLeftClose, PanelLeft } from 'lucide-react';
import { UserMenu } from './UserMenu';
import { IconButton } from './primitives';

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
        <IconButton
          icon={sidebarCollapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          variant="default"
          size="md"
          windowNoDrag
        />
      </div>

      {/* Center: Title */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-300">Code Agent</span>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1">
        {/* Workspace Toggle */}
        <IconButton
          icon={<FolderOpen className="w-4 h-4" />}
          aria-label={showWorkspace ? 'Hide workspace' : 'Show workspace'}
          onClick={() => setShowWorkspace(!showWorkspace)}
          variant={showWorkspace ? 'active' : 'default'}
          size="md"
          windowNoDrag
        />

        {/* Settings */}
        <IconButton
          icon={<Settings className="w-4 h-4" />}
          aria-label="Settings"
          onClick={() => setShowSettings(true)}
          variant="default"
          size="md"
          windowNoDrag
        />

        {/* User Menu */}
        <UserMenu />
      </div>
    </div>
  );
};
