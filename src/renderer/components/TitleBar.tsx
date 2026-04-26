// ============================================================================
// TitleBar - Right side title bar with workspace path and task panel toggle
// ============================================================================
import React, { useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { PanelLeftClose, PanelLeft, PanelRightClose, PanelRight, FolderOpen } from 'lucide-react';
import { isWebMode, isTauriMode } from '../utils/platform';
import { IconButton } from './primitives';
import { SessionActionsMenu } from './SessionActionsMenu';
export const TitleBar: React.FC = () => {
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    workingDirectory,
    setWorkingDirectory: setAppWorkingDirectory,
    workbenchTabs,
    openWorkbenchTab,
    closeWorkbenchTab,
  } = useAppStore();
  const isTaskTabOpen = workbenchTabs.includes('task');
  const composerWorkingDirectory = useComposerStore((state) => state.workingDirectory);
  const setComposerWorkingDirectory = useComposerStore((state) => state.setWorkingDirectory);
  // 当前消息发送用的工作目录（composerStore）优先，fallback 到全局 appStore.workingDirectory
  const effectiveWorkingDirectory = composerWorkingDirectory ?? workingDirectory;
  // Get workspace name from path
  const getWorkspaceName = (path: string | null): string => {
    if (!path) return '';
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
  };
  const workspaceLabel = effectiveWorkingDirectory
    ? getWorkspaceName(effectiveWorkingDirectory)
    : '选择目录';

  const handleSelectDirectory = useCallback(async () => {
    try {
      let selectedPath: string | null = null;
      if (isWebMode()) {
        selectedPath = window.prompt('输入工作目录路径', effectiveWorkingDirectory || '')?.trim() || null;
      } else if (isTauriMode()) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const result = await open({ directory: true, multiple: false, title: '选择工作目录' });
        selectedPath = typeof result === 'string' ? result : null;
      }
      if (selectedPath) {
        setComposerWorkingDirectory(selectedPath);
        setAppWorkingDirectory(selectedPath);
      }
    } catch (error) {
      console.error('Failed to select working directory:', error);
    }
  }, [effectiveWorkingDirectory, setAppWorkingDirectory, setComposerWorkingDirectory]);
  return (
    <div className="h-12 flex items-center justify-between px-4 border-b border-white/[0.06] window-drag bg-transparent backdrop-blur-sm relative z-30">
      {/* Left: sidebar toggle + workspace chip */}
      <div className="flex items-center gap-2">
        {/* Sidebar Toggle */}
        <IconButton
          icon={sidebarCollapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          variant="ghost"
          size="md"
          windowNoDrag
        />
        {/* Workspace Chip — 点击切换当前消息/会话的工作目录 */}
        <button
          type="button"
          onClick={handleSelectDirectory}
          className="window-no-drag inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-white/[0.14] hover:bg-white/[0.05] hover:text-zinc-100"
          title={effectiveWorkingDirectory || '选择工作目录'}
        >
          <FolderOpen className="h-3.5 w-3.5 text-amber-400" />
          <span className="max-w-[180px] truncate">{workspaceLabel}</span>
        </button>
        <SessionActionsMenu />
      </div>
      {/* Right: 仅保留 Task Panel toggle —— 顶栏布局对称，其余工具进左下 User Menu，
          tab 重开走 WorkbenchTabs 的 + 按钮 */}
      <div className="flex items-center gap-1">
        <IconButton
          icon={isTaskTabOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRight className="w-4 h-4" />}
          aria-label={isTaskTabOpen ? 'Hide task panel' : 'Show task panel'}
          onClick={() => (isTaskTabOpen ? closeWorkbenchTab('task') : openWorkbenchTab('task'))}
          variant="ghost"
          size="md"
          windowNoDrag
        />
      </div>
    </div>
  );
};
