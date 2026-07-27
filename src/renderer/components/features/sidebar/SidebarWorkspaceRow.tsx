// ============================================================================
// SidebarWorkspaceRow —— 侧栏「当前工作目录」行。
// 顶栏目录 chip 退役（2026-07-26 UX 拍板：目录选择并入侧栏项目组体系，顶栏只留栏开关），
// 这里是选/换当前工作目录的唯一入口。
// 数据流沿用原 TitleBar chip 的同一条通道，不新造：
//   读：composerStore.workingDirectory ?? appStore.workingDirectory（发送用的 composer 优先）
//   写：composerStore + appStore 同时写，并持久化到当前会话（IPC session.update），
//       让 sidebar 工作区分组重新归位、agent 运行用到正确的 cwd。
// ============================================================================

import React, { useCallback, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../../../stores/appStore';
import { useComposerStore } from '../../../stores/composerStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { isTauriMode } from '../../../utils/platform';
import { pickNativeDirectory } from '../../../services/tauriPluginFacade';
import { Button, Input, Modal } from '../../primitives';

/** 取路径末段作显示名（兼容 POSIX / Windows 分隔符）。 */
function getDirectoryName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export const SidebarWorkspaceRow: React.FC = () => {
  const { t } = useI18n();
  const sb = t.sidebar;
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const setAppWorkingDirectory = useAppStore((state) => state.setWorkingDirectory);
  const composerWorkingDirectory = useComposerStore((state) => state.workingDirectory);
  const setComposerWorkingDirectory = useComposerStore((state) => state.setWorkingDirectory);
  // 与 TitleBar chip 同一判定：composer 优先，fallback 全局
  const effectiveWorkingDirectory = composerWorkingDirectory ?? workingDirectory;

  // web 模式没有系统目录选择器，也不再退化到 window.prompt（深色 UI 里突兀且文案不走 i18n）；
  // 用 primitives 的 Modal+Input 做最小路径输入。tauri 桌面走原生选择器。
  const [pathDialogOpen, setPathDialogOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState('');

  const applyDirectory = useCallback(async (selectedPath: string) => {
    setComposerWorkingDirectory(selectedPath);
    setAppWorkingDirectory(selectedPath);
    // 持久化到当前会话（同原 TitleBar chip 的通道）
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
  }, [setAppWorkingDirectory, setComposerWorkingDirectory]);

  const handleSelectDirectory = useCallback(async () => {
    try {
      if (isTauriMode()) {
        const selectedPath = await pickNativeDirectory({ title: sb.selectDirectoryTitle });
        if (selectedPath) await applyDirectory(selectedPath);
      } else {
        setPathDraft(effectiveWorkingDirectory || '');
        setPathDialogOpen(true);
      }
    } catch (error) {
      console.error('Failed to select working directory:', error);
    }
  }, [applyDirectory, effectiveWorkingDirectory, sb.selectDirectoryTitle]);

  const handleConfirmPath = useCallback(async () => {
    const trimmed = pathDraft.trim();
    if (!trimmed) return;
    setPathDialogOpen(false);
    await applyDirectory(trimmed);
  }, [applyDirectory, pathDraft]);

  // 未设置时是引导态（「选择目录」自解释）；已设置时弱化为次要色 ——
  // 欢迎页（NewSessionWelcome）已把目录作为上下文标签显示，侧栏行不再抢一等视觉。
  const label = effectiveWorkingDirectory ? getDirectoryName(effectiveWorkingDirectory) : sb.selectDirectory;
  return (
    <>
      <button /* ds-allow:button: 侧栏单行列表行（裸图标+标题左对齐布局，与能力区各行同一节奏），Button primitive 是居中动作按钮形状，变体不适配列表行 */
        type="button"
        onClick={handleSelectDirectory}
        title={effectiveWorkingDirectory || sb.selectDirectoryTitle}
        aria-label={`${sb.currentDirectory}: ${label}`}
        data-testid="sidebar-workspace-row"
        className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-zinc-800/70"
      >
        <FolderOpen className="h-4 w-4 flex-shrink-0 text-zinc-500" />
        <span
          className={`min-w-0 flex-1 truncate text-sm ${
            effectiveWorkingDirectory ? 'text-zinc-500 group-hover:text-zinc-300' : 'text-zinc-300 group-hover:text-zinc-100'
          }`}
        >
          {label}
        </span>
      </button>

      <Modal
        isOpen={pathDialogOpen}
        onClose={() => setPathDialogOpen(false)}
        title={sb.pathDialogTitle}
        size="md"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setPathDialogOpen(false)}>
              {sb.cancel}
            </Button>
            <Button size="sm" variant="primary" onClick={() => { void handleConfirmPath(); }} disabled={!pathDraft.trim()}>
              {sb.confirm}
            </Button>
          </>
        }
      >
        <p className="text-xs text-zinc-400 leading-relaxed mb-3">{sb.pathDialogDescription}</p>
        <Input
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleConfirmPath();
          }}
          placeholder={sb.pathDialogPlaceholder}
          aria-label={sb.pathDialogTitle}
          autoFocus
        />
      </Modal>
    </>
  );
};
