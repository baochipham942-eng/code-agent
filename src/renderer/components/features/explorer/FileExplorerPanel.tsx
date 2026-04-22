// ============================================================================
// FileExplorerPanel - FloatBoat-inspired file browser with multi-tab support
// ============================================================================

import React, { useCallback, useEffect, useRef } from 'react';
import {
  FolderOpen, FolderClosed, File, X, Plus, RefreshCw,
  ChevronRight, ChevronDown, Send, FileText, Image, Code2,
  FileSpreadsheet, Presentation, Film, Music, Archive,
  FilePlus, FolderPlus,
} from 'lucide-react';
import { useExplorerStore } from '../../../stores/explorerStore';
import { useAppStore } from '../../../stores/appStore';
import { IPC_DOMAINS } from '@shared/ipc';
import type { FileInfo } from '@shared/contract';

// ── Helpers ──

async function listFiles(dirPath: string): Promise<FileInfo[]> {
  const response = await window.domainAPI?.invoke<FileInfo[]>(
    IPC_DOMAINS.WORKSPACE, 'listFiles', { dirPath }
  );
  if (!response?.success) return [];
  return (response.data ?? []).sort((a, b) => {
    // Directories first, then alphabetical
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function joinPath(parent: string, name: string): string {
  if (parent.endsWith('/')) return `${parent}${name}`;
  return `${parent}/${name}`;
}

function isInvalidName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (trimmed === '.' || trimmed === '..') return true;
  if (/[/\\]/.test(trimmed)) return true;
  return false;
}

async function createFsEntry(
  parentPath: string,
  name: string,
  kind: 'file' | 'folder'
): Promise<{ ok: true; info: FileInfo } | { ok: false; message: string }> {
  const fullPath = joinPath(parentPath, name.trim());
  const action = kind === 'file' ? 'createFile' : 'createFolder';
  const payload = kind === 'file' ? { filePath: fullPath } : { dirPath: fullPath };
  const response = await window.domainAPI?.invoke<FileInfo>(
    IPC_DOMAINS.WORKSPACE, action, payload
  );
  if (!response?.success || !response.data) {
    return { ok: false, message: response?.error?.message ?? '创建失败' };
  }
  return { ok: true, info: response.data };
}

function getFileIcon(name: string, isDir: boolean) {
  if (isDir) return null; // handled by chevron
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const iconClass = 'w-3.5 h-3.5 flex-shrink-0';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'rb', 'vue', 'css', 'scss', 'html'].includes(ext))
    return <Code2 className={`${iconClass} text-blue-400`} />;
  if (['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv'].includes(ext))
    return <FileText className={`${iconClass} text-zinc-400`} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext))
    return <Image className={`${iconClass} text-emerald-400`} />;
  if (['xlsx', 'xls', 'numbers'].includes(ext))
    return <FileSpreadsheet className={`${iconClass} text-green-400`} />;
  if (['pptx', 'ppt', 'key'].includes(ext))
    return <Presentation className={`${iconClass} text-orange-400`} />;
  if (['mp4', 'mov', 'webm', 'avi'].includes(ext))
    return <Film className={`${iconClass} text-purple-400`} />;
  if (['mp3', 'wav', 'flac', 'aac'].includes(ext))
    return <Music className={`${iconClass} text-pink-400`} />;
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext))
    return <Archive className={`${iconClass} text-amber-400`} />;
  return <File className={`${iconClass} text-zinc-500`} />;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Hidden directories/files to skip
const HIDDEN_NAMES = new Set([
  'node_modules', '.git', '.DS_Store', 'dist', 'target',
  '.next', '.cache', '__pycache__', '.turbo',
]);

// ── CreateInputRow ──

const CreateInputRow: React.FC<{
  parentPath: string;
  kind: 'file' | 'folder';
  depth: number;
  onDone: (created: FileInfo | null) => void;
}> = ({ parentPath, kind, depth, onDone }) => {
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const paddingLeft = 8 + depth * 16;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (isInvalidName(name)) {
      setError('名称不能为空、"."、".."，或包含 / \\');
      return;
    }
    setSubmitting(true);
    const result = await createFsEntry(parentPath, name, kind);
    if (!result.ok) {
      setError(result.message);
      setSubmitting(false);
      return;
    }
    onDone(result.info);
  }, [submitting, name, parentPath, kind, onDone]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDone(null);
    }
  }, [submit, onDone]);

  const icon = kind === 'file'
    ? <File className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
    : <FolderClosed className="w-3.5 h-3.5 text-amber-400/70 flex-shrink-0" />;

  return (
    <div
      className="flex items-center gap-1 py-0.5 pr-2"
      style={{ paddingLeft }}
    >
      <span className="w-4 h-4 flex-shrink-0" />
      {icon}
      <input
        ref={inputRef}
        className={`flex-1 bg-zinc-800 rounded px-1 py-0.5 text-xs text-zinc-100 focus:outline-none ${
          error ? 'border border-red-500/60' : 'border border-primary-500/40 focus:border-primary-500'
        }`}
        value={name}
        onChange={(e) => { setName(e.target.value); setError(null); }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // If user blurred without typing anything, cancel. Otherwise keep the input open
          // so they can fix the name after an error.
          if (!name.trim() && !error) onDone(null);
        }}
        placeholder={kind === 'file' ? '文件名' : '文件夹名'}
        disabled={submitting}
      />
      {error && (
        <span
          className="text-[10px] text-red-400 flex-shrink-0 cursor-help"
          title={error}
        >
          !
        </span>
      )}
    </div>
  );
};

// ── FileTreeNode ──

const FileTreeNode: React.FC<{
  file: FileInfo;
  depth: number;
}> = ({ file, depth }) => {
  const {
    expandedPaths, loadingPaths, dirContents, selectedPaths, pendingCreate,
    toggleExpanded, setDirContents, setLoading, setExpanded, startCreate, cancelCreate,
  } = useExplorerStore();

  const isExpanded = expandedPaths.has(file.path);
  const isLoading = loadingPaths.has(file.path);
  const isSelected = selectedPaths.includes(file.path);
  const children = dirContents[file.path];

  const handleToggle = useCallback(async () => {
    if (!file.isDirectory) return;

    if (isExpanded) {
      toggleExpanded(file.path);
      return;
    }

    // Load contents if not cached
    if (!children) {
      setLoading(file.path, true);
      const contents = await listFiles(file.path);
      setDirContents(file.path, contents);
      setLoading(file.path, false);
    }
    toggleExpanded(file.path);
  }, [file.path, file.isDirectory, isExpanded, children, toggleExpanded, setDirContents, setLoading]);

  const handleClick = useCallback(() => {
    if (file.isDirectory) {
      handleToggle();
    } else {
      // Open file
      window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'openPath', { filePath: file.path });
    }
  }, [file.isDirectory, file.path, handleToggle]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', file.path);
    e.dataTransfer.setData('application/x-explorer-path', file.path);
    e.dataTransfer.effectAllowed = 'copy';
  }, [file.path]);

  // Send file to chat as context via IACT
  const handleSendToChat = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const prefix = file.isDirectory ? '分析这个目录' : '查看这个文件';
    window.dispatchEvent(new CustomEvent('iact:send', {
      detail: `${prefix}: ${file.path}`
    }));
  }, [file.path, file.isDirectory]);

  const handleCreateClick = useCallback(async (
    e: React.MouseEvent, kind: 'file' | 'folder'
  ) => {
    e.stopPropagation();
    if (!file.isDirectory) return;

    // Ensure folder is expanded and children loaded before the input appears.
    if (!children) {
      setLoading(file.path, true);
      const contents = await listFiles(file.path);
      setDirContents(file.path, contents);
      setLoading(file.path, false);
    }
    setExpanded(file.path, true);
    startCreate(file.path, kind);
  }, [file.isDirectory, file.path, children, setDirContents, setLoading, setExpanded, startCreate]);

  const refreshParent = useCallback(async () => {
    const contents = await listFiles(file.path);
    setDirContents(file.path, contents);
  }, [file.path, setDirContents]);

  if (HIDDEN_NAMES.has(file.name)) return null;

  const paddingLeft = 8 + depth * 16;

  return (
    <>
      <div
        className={`flex items-center gap-1 py-0.5 pr-2 cursor-pointer group hover:bg-zinc-800/60 transition-colors ${
          isSelected ? 'bg-primary-500/10' : ''
        }`}
        style={{ paddingLeft }}
        onClick={handleClick}
        draggable
        onDragStart={handleDragStart}
        title={file.path}
      >
        {/* Expand/collapse chevron for directories */}
        {file.isDirectory ? (
          <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
            {isLoading ? (
              <RefreshCw className="w-3 h-3 text-zinc-500 animate-spin" />
            ) : isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
            )}
          </span>
        ) : (
          <span className="w-4 h-4 flex-shrink-0" /> /* spacer for files */
        )}

        {/* Icon */}
        {file.isDirectory ? (
          isExpanded
            ? <FolderOpen className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
            : <FolderClosed className="w-3.5 h-3.5 text-amber-400/70 flex-shrink-0" />
        ) : (
          getFileIcon(file.name, false)
        )}

        {/* Name */}
        <span className="text-xs truncate flex-1 text-zinc-300 group-hover:text-zinc-100">
          {file.name}
        </span>

        {/* Size (files only) */}
        {!file.isDirectory && file.size !== undefined && (
          <span className="text-[10px] text-zinc-600 flex-shrink-0 tabular-nums">
            {formatSize(file.size)}
          </span>
        )}

        {/* New File / New Folder buttons (folders only, on hover) */}
        {file.isDirectory && (
          <>
            <button
              onClick={(e) => handleCreateClick(e, 'file')}
              className="hidden group-hover:flex items-center justify-center w-4 h-4 rounded hover:bg-zinc-600 flex-shrink-0"
              title="新建文件"
            >
              <FilePlus className="w-2.5 h-2.5 text-zinc-400" />
            </button>
            <button
              onClick={(e) => handleCreateClick(e, 'folder')}
              className="hidden group-hover:flex items-center justify-center w-4 h-4 rounded hover:bg-zinc-600 flex-shrink-0"
              title="新建文件夹"
            >
              <FolderPlus className="w-2.5 h-2.5 text-zinc-400" />
            </button>
          </>
        )}

        {/* Send to chat button (on hover) */}
        <button
          onClick={handleSendToChat}
          className="hidden group-hover:flex items-center justify-center w-4 h-4 rounded hover:bg-zinc-600 flex-shrink-0"
          title="发送到对话"
        >
          <Send className="w-2.5 h-2.5 text-zinc-400" />
        </button>
      </div>

      {/* Inline create input (when this folder is the pending create target) */}
      {file.isDirectory && isExpanded && pendingCreate?.parentPath === file.path && (
        <CreateInputRow
          parentPath={file.path}
          kind={pendingCreate.kind}
          depth={depth + 1}
          onDone={(info) => {
            cancelCreate();
            if (info) void refreshParent();
          }}
        />
      )}

      {/* Children */}
      {file.isDirectory && isExpanded && children && (
        children
          .filter(c => !HIDDEN_NAMES.has(c.name))
          .map((child) => (
            <FileTreeNode key={child.path} file={child} depth={depth + 1} />
          ))
      )}
    </>
  );
};

// ── TabBar ──

const TabBar: React.FC = () => {
  const { tabs, activeTabId, setActiveTab, closeTab, openOrFocusTab } = useExplorerStore();
  const workingDirectory = useAppStore((s) => s.workingDirectory);

  const handleAddTab = useCallback(async () => {
    // Use workspace select directory
    try {
      const response = await window.domainAPI?.invoke<string>(
        IPC_DOMAINS.WORKSPACE, 'selectDirectory', {}
      );
      if (response?.success && response.data) {
        const dirPath = response.data;
        const label = dirPath.split('/').pop() || dirPath;
        openOrFocusTab(dirPath, label);
      }
    } catch {
      // Fallback: use working directory
      if (workingDirectory) {
        const label = workingDirectory.split('/').pop() || 'Root';
        openOrFocusTab(workingDirectory, label);
      }
    }
  }, [openOrFocusTab, workingDirectory]);

  return (
    <div className="flex items-center gap-0.5 px-1 overflow-x-auto scrollbar-none">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`flex items-center gap-1 px-2 py-1 rounded-t text-xs cursor-pointer transition-colors max-w-[140px] ${
            tab.id === activeTabId
              ? 'bg-zinc-800 text-zinc-200'
              : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
          }`}
          onClick={() => setActiveTab(tab.id)}
        >
          <FolderOpen className="w-3 h-3 flex-shrink-0 text-amber-400/70" />
          <span className="truncate">{tab.label}</span>
          <button
            onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
            className="flex-shrink-0 p-0.5 rounded hover:bg-zinc-700 opacity-0 group-hover:opacity-100"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      ))}
      <button
        onClick={handleAddTab}
        className="p-1 text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 rounded transition-colors"
        title="打开目录"
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
};

// ── Main FileExplorerPanel ──

interface FileExplorerPanelProps {
  onClose: () => void;
}

export const FileExplorerPanel: React.FC<FileExplorerPanelProps> = ({ onClose }) => {
  const {
    tabs, activeTabId, dirContents, pendingCreate,
    openOrFocusTab, setDirContents, setLoading, startCreate, cancelCreate,
  } = useExplorerStore();
  const workingDirectory = useAppStore((s) => s.workingDirectory);

  // Sync active tab with session workingDirectory: open it or focus if already open.
  useEffect(() => {
    if (!workingDirectory) return;
    const label = workingDirectory.split('/').pop() || 'Project';
    openOrFocusTab(workingDirectory, label);
  }, [workingDirectory, openOrFocusTab]);

  // Load root directory contents when active tab changes
  const activeTab = tabs.find((t) => t.id === activeTabId);
  useEffect(() => {
    if (!activeTab) return;
    const rootPath = activeTab.rootPath;
    if (dirContents[rootPath]) return; // already loaded

    let cancelled = false;
    setLoading(rootPath, true);
    listFiles(rootPath).then((files) => {
      if (!cancelled) {
        setDirContents(rootPath, files);
        setLoading(rootPath, false);
      }
    });
    return () => { cancelled = true; };
  }, [activeTab, dirContents, setDirContents, setLoading]);

  const handleRefresh = useCallback(async () => {
    if (!activeTab) return;
    setLoading(activeTab.rootPath, true);
    const files = await listFiles(activeTab.rootPath);
    setDirContents(activeTab.rootPath, files);
    setLoading(activeTab.rootPath, false);
  }, [activeTab, setDirContents, setLoading]);

  const rootFiles = activeTab ? dirContents[activeTab.rootPath] : undefined;

  return (
    <div className="flex flex-col h-full bg-zinc-900 border-r border-zinc-700">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700">
        <h3 className="text-sm font-medium text-zinc-200 flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-amber-400" />
          文件
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => activeTab && startCreate(activeTab.rootPath, 'file')}
            disabled={!activeTab}
            className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            title="新建文件"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => activeTab && startCreate(activeTab.rootPath, 'folder')}
            disabled={!activeTab}
            className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            title="新建文件夹"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleRefresh}
            className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
            title="刷新"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
            title="关闭"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tab bar */}
      {tabs.length > 0 && (
        <div className="border-b border-zinc-800">
          <TabBar />
        </div>
      )}

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {!activeTab ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-zinc-600">
            <FolderOpen className="w-8 h-8" />
            <span className="text-xs">暂无打开的目录</span>
            <button
              onClick={() => {
                if (workingDirectory) {
                  const label = workingDirectory.split('/').pop() || 'Project';
                  openOrFocusTab(workingDirectory, label);
                }
              }}
              className="text-xs text-primary-400 hover:text-primary-300"
            >
              打开项目目录
            </button>
          </div>
        ) : rootFiles === undefined ? (
          <div className="flex items-center justify-center h-20 text-zinc-600">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" />
            <span className="text-xs">加载中...</span>
          </div>
        ) : rootFiles.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-zinc-600 text-xs">
            空目录
          </div>
        ) : (
          <>
            {activeTab && pendingCreate?.parentPath === activeTab.rootPath && (
              <CreateInputRow
                parentPath={activeTab.rootPath}
                kind={pendingCreate.kind}
                depth={0}
                onDone={(info) => {
                  cancelCreate();
                  if (info) void handleRefresh();
                }}
              />
            )}
            {rootFiles
              .filter(f => !HIDDEN_NAMES.has(f.name))
              .map((file) => (
                <FileTreeNode key={file.path} file={file} depth={0} />
              ))}
          </>
        )}
      </div>
    </div>
  );
};
