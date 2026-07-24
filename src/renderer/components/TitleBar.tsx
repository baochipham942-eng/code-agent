// ============================================================================
// TitleBar - Right side title bar with workspace path and task panel toggle
// ============================================================================
import React, { useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { useSessionStore } from '../stores/sessionStore';
import { PanelLeftClose, PanelLeft, PanelRightClose, PanelRight, FolderOpen } from 'lucide-react';
import { isWebMode, isTauriMode } from '../utils/platform';
import { IPC_DOMAINS } from '@shared/ipc';
import { IconButton } from './primitives';
import { SessionActionsMenu } from './SessionActionsMenu';
import { pickNativeDirectory } from '../services/tauriPluginFacade';
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
  const isOverviewOpen = workbenchTabs.includes('overview');
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
        selectedPath = await pickNativeDirectory({ title: '选择工作目录' });
      }
      if (selectedPath) {
        setComposerWorkingDirectory(selectedPath);
        setAppWorkingDirectory(selectedPath);
        // 持久化到当前会话，让 sidebar 工作区分组重新归位、agent 运行用到正确的 cwd
        const currentSessionId = useSessionStore.getState().currentSessionId;
        if (currentSessionId) {
          try {
            await window.domainAPI?.invoke(IPC_DOMAINS.SESSION, 'update', {
              sessionId: currentSessionId,
              updates: { workingDirectory: selectedPath },
            });
          } catch (err) {
            console.error('Failed to persist session workingDirectory:', err);
          }
        }
      }
    } catch (error) {
      console.error('Failed to select working directory:', error);
    }
  }, [effectiveWorkingDirectory, setAppWorkingDirectory, setComposerWorkingDirectory]);
  return (
    <div className="h-12 flex items-center justify-between px-4 border-b border-border-muted bg-transparent backdrop-blur-sm relative z-30">
      {/* Left: sidebar toggle + workspace chip */}
      <div className="flex items-center gap-2">
        {/* Sidebar Toggle */}
        <IconButton
          icon={sidebarCollapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          variant="ghost"
          size="md"
        />
        {/* Workspace Chip — 点击切换当前消息/会话的工作目录 */}
        <button
          type="button"
          onClick={handleSelectDirectory}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border-muted bg-surface-subtle px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-border-hover hover:bg-surface-hover hover:text-zinc-100"
          // 未选目录时按钮已显示「选择目录」自解释，不再挂 title——否则原生 tooltip
          // 会在窗口左上角悬出一个看似卡住的「选择工作目录」浮层。选了目录才用 title 显示完整路径。
          title={effectiveWorkingDirectory || undefined}
        >
          <FolderOpen className="h-3.5 w-3.5 text-amber-400" />
          <span className="max-w-[180px] truncate">{workspaceLabel}</span>
        </button>
        <SessionActionsMenu />
      </div>
      {/* Right: Task Panel toggle */}
      <div className="flex items-center gap-2">
        <IconButton
          icon={isOverviewOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRight className="w-4 h-4" />}
          aria-label={isOverviewOpen ? 'Hide overview' : 'Show overview'}
          onClick={() => (isOverviewOpen ? closeWorkbenchTab('task') : openWorkbenchTab('task'))}
          variant="ghost"
          size="md"
        />
      </div>
    </div>
  );
};
