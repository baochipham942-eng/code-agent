// ============================================================================
// TitleBar - Right side title bar with workspace path and task panel toggle
// ============================================================================
import React, { useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { useDisclosure } from '../hooks/useDisclosure';
import { PanelLeftClose, PanelLeft, PanelRightClose, PanelRight, FolderOpen, GitBranch, FlaskConical, Monitor, Clock3 } from 'lucide-react';
import { isWebMode } from '../utils/platform';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../services/ipcService';
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
    setShowEvalCenter,
    showDesktopPanel,
    setShowDesktopPanel,
    showCronCenter,
    setShowCronCenter,
    workingDirectory,
    setWorkingDirectory: setAppWorkingDirectory,
  } = useAppStore();
  const composerWorkingDirectory = useComposerStore((state) => state.workingDirectory);
  const setComposerWorkingDirectory = useComposerStore((state) => state.setWorkingDirectory);
  // 当前消息发送用的工作目录（composerStore）优先，fallback 到全局 appStore.workingDirectory
  const effectiveWorkingDirectory = composerWorkingDirectory ?? workingDirectory;
  // 获取当前会话 ID
  // DAG 面板权限检查
  const { dagPanelEnabled } = useDisclosure();
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
      } else {
        selectedPath = await ipcService.invoke(IPC_CHANNELS.WORKSPACE_SELECT_DIRECTORY);
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
      </div>
      {/* Right: EvalCenter + Lab + DAG Panel Toggle + Task Panel Toggle */}
      <div className="flex items-center gap-1">
        {/* EvalCenter Button (奶酪图标) — 合并了评测 + 遥测 */}
        <IconButton
          icon={<CheeseIcon className="w-4 h-4" />}
          aria-label="评测中心"
          onClick={() => setShowEvalCenter(true)}
          variant="ghost"
          size="md"
          windowNoDrag
          className="text-amber-400/70 hover:text-amber-400"
        />
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
        <IconButton
          icon={<Clock3 className="w-4 h-4" />}
          aria-label={showCronCenter ? '隐藏定时任务中心' : '显示定时任务中心'}
          onClick={() => setShowCronCenter(!showCronCenter)}
          variant="ghost"
          size="md"
          windowNoDrag
          className={showCronCenter ? 'text-amber-400' : 'text-amber-400/70 hover:text-amber-400'}
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
        {/* Desktop Collector Toggle */}
        <IconButton
          icon={<Monitor className="w-4 h-4" />}
          aria-label={showDesktopPanel ? '隐藏桌面采集' : '桌面采集'}
          onClick={() => setShowDesktopPanel(!showDesktopPanel)}
          variant="ghost"
          size="md"
          windowNoDrag
          className={showDesktopPanel ? 'text-cyan-400' : ''}
        />
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
