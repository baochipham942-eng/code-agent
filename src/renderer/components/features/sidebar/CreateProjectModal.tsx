// ============================================================================
// CreateProjectModal —— 侧栏「项目」区「+」入口的创建项目弹窗（2026-07-29，
// 侧栏项目区 redesign，参考 Codex/ChatGPT：项目名称 + Source folders + 取消/创建）。
// 目录选择双路径沿用 ChatView.handlePickDirectory 的旧约定：
// Tauri 壳走原生目录选择器（pickNativeDirectory），浏览器走 DirectoryPickerModal。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { Button, Modal } from '../../primitives';
import { useI18n } from '../../../hooks/useI18n';
import { isTauriMode } from '../../../utils/platform';
import { pickNativeDirectory } from '../../../services/tauriPluginFacade';

// 浏览器态才用到的目录选择器，lazy 加载：它的依赖链（localBridgeStore）在模块初始化时
// 就读 localStorage，侧栏测试（node 环境）经 Sidebar → 本组件的静态 import 链会被拖炸。
const DirectoryPickerModal = React.lazy(() =>
  import('../chat/DirectoryPickerModal').then((module) => ({ default: module.DirectoryPickerModal })),
);

interface CreateProjectModalProps {
  isOpen: boolean;
  /** 创建进行中（IPC + 首条会话建立）：禁用提交并显 spinner。 */
  creating: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; workspacePath: string }) => void;
}

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({
  isOpen,
  creating,
  onClose,
  onSubmit,
}) => {
  const { t } = useI18n();
  const sb = t.sidebar;
  const [name, setName] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);

  // 每次打开重置表单
  useEffect(() => {
    if (isOpen) {
      setName('');
      setFolder(null);
      setDirPickerOpen(false);
    }
  }, [isOpen]);

  const handlePickFolder = async () => {
    if (isTauriMode()) {
      try {
        const selected = await pickNativeDirectory({ title: sb.selectDirectoryTitle });
        if (selected) setFolder(selected);
      } catch (error) {
        console.error('Failed to pick project directory:', error);
      }
      return;
    }
    setDirPickerOpen(true);
  };

  const canSubmit = Boolean(name.trim()) && Boolean(folder) && !creating;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={creating ? () => {} : onClose}
        title={sb.createProjectTitle}
        size="sm"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={onClose} disabled={creating}>
              {sb.cancel}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!canSubmit}
              onClick={() => {
                if (!canSubmit || !folder) return;
                onSubmit({ name: name.trim(), workspacePath: folder });
              }}
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : sb.createProjectSubmit}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-zinc-400">{sb.createProjectNameLabel}</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={sb.createProjectNamePlaceholder}
              autoFocus
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-hidden"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-zinc-400">{sb.createProjectSourceLabel}</span>
            <button /* ds-allow:button: 目录选择是带图标的虚线热区行，Button primitive 无此变体 */
              type="button"
              onClick={() => { void handlePickFolder(); }}
              data-testid="create-project-pick-folder"
              className="flex w-full items-center gap-2 rounded-md border border-dashed border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5 text-left text-sm transition-colors hover:border-zinc-500 hover:text-zinc-200"
            >
              <FolderOpen className="h-4 w-4 shrink-0 text-zinc-500" />
              <span className={`min-w-0 flex-1 truncate ${folder ? 'font-mono text-xs text-zinc-300' : 'text-zinc-500'}`}>
                {folder ?? sb.createProjectPickFolder}
              </span>
            </button>
          </div>
        </div>
      </Modal>
      {/* 浏览器态的目录选择（Tauri 走原生选择器，用不到它） */}
      {dirPickerOpen && (
        <React.Suspense fallback={null}>
          <DirectoryPickerModal
            isOpen={dirPickerOpen}
            onSelect={(directory) => {
              setDirPickerOpen(false);
              setFolder(directory);
            }}
            onClose={() => setDirPickerOpen(false)}
          />
        </React.Suspense>
      )}
    </>
  );
};
