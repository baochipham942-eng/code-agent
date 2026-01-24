// ============================================================================
// TitleBar - Linear-style Title Bar with Gen selector, workspace path, session title
// ============================================================================

import React, { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { PanelLeftClose, PanelLeft, LayoutGrid, Pencil, Check, X } from 'lucide-react';
import { GenerationBadge } from './GenerationBadge';
import { IconButton } from './primitives';
import { IPC_CHANNELS } from '@shared/ipc';

export const TitleBar: React.FC = () => {
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    showTaskPanel,
    setShowTaskPanel,
    workingDirectory,
  } = useAppStore();

  const { sessions, currentSessionId, updateSessionTitle } = useSessionStore();

  // Session title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Get current session
  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const sessionTitle = currentSession?.title || 'New Chat';

  // Get workspace name from path
  const getWorkspaceName = (path: string | null): string => {
    if (!path) return '';
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
  };

  const workspaceName = getWorkspaceName(workingDirectory);

  // Handle title edit start
  const handleStartEdit = () => {
    setEditedTitle(sessionTitle);
    setIsEditingTitle(true);
  };

  // Handle title save
  const handleSaveTitle = async () => {
    if (currentSessionId && editedTitle.trim()) {
      updateSessionTitle(currentSessionId, editedTitle.trim());
      // Note: Title updates are persisted automatically through sessionStore
      // or when messages are sent. No separate IPC call needed.
    }
    setIsEditingTitle(false);
  };

  // Handle title cancel
  const handleCancelEdit = () => {
    setIsEditingTitle(false);
    setEditedTitle('');
  };

  // Handle key press in title input
  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveTitle();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  // Focus input when editing starts
  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  return (
    <div className="h-12 flex items-center justify-between px-4 border-b border-zinc-800/50 window-drag bg-surface-950/80 backdrop-blur-sm">
      {/* Left: macOS traffic lights space + sidebar toggle + Gen badge + workspace path */}
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

        {/* Generation Badge */}
        <div className="window-no-drag">
          <GenerationBadge />
        </div>

        {/* Workspace Path */}
        {workspaceName && (
          <span className="text-xs text-zinc-500 hidden sm:inline" title={workingDirectory || ''}>
            {workspaceName}
          </span>
        )}
      </div>

      {/* Center: Session Title (editable) */}
      <div className="flex items-center gap-2 window-no-drag">
        {isEditingTitle ? (
          <div className="flex items-center gap-1">
            <input
              ref={titleInputRef}
              type="text"
              value={editedTitle}
              onChange={(e) => setEditedTitle(e.target.value)}
              onKeyDown={handleTitleKeyDown}
              onBlur={handleSaveTitle}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-primary-500 w-48"
              maxLength={100}
            />
            <IconButton
              icon={<Check className="w-3.5 h-3.5" />}
              aria-label="Save"
              onClick={handleSaveTitle}
              variant="default"
              size="sm"
            />
            <IconButton
              icon={<X className="w-3.5 h-3.5" />}
              aria-label="Cancel"
              onClick={handleCancelEdit}
              variant="default"
              size="sm"
            />
          </div>
        ) : (
          <button
            onClick={handleStartEdit}
            className="flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-800/50 transition-colors group"
          >
            <span className="text-sm font-medium text-zinc-200 truncate max-w-xs">
              {sessionTitle}
            </span>
            <Pencil className="w-3 h-3 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
        )}
      </div>

      {/* Right: Task Panel Toggle */}
      <div className="flex items-center gap-1">
        <IconButton
          icon={<LayoutGrid className="w-4 h-4" />}
          aria-label={showTaskPanel ? 'Hide task panel' : 'Show task panel'}
          onClick={() => setShowTaskPanel(!showTaskPanel)}
          variant={showTaskPanel ? 'active' : 'default'}
          size="md"
          windowNoDrag
        />
      </div>
    </div>
  );
};
