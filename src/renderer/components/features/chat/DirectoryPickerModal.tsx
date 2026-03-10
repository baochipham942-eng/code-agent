// ============================================================================
// DirectoryPickerModal - First-time working directory selection modal
// Reuses directory tree logic from WorkingDirectoryPicker
// ============================================================================

import React, { useState, useCallback, useEffect } from 'react';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Loader2,
  RefreshCw,
  FolderTree,
  X,
} from 'lucide-react';
import { useLocalBridgeStore } from '../../../stores/localBridgeStore';
import { Button } from '../../primitives';

// ============================================================================
// Types
// ============================================================================

interface DirectoryPickerModalProps {
  isOpen: boolean;
  onSelect: (directory: string) => void;
  onClose: () => void;
}

interface DirNode {
  name: string;
  path: string;
  children: DirNode[] | null;
  isLoading: boolean;
  isExpanded: boolean;
}

// ============================================================================
// Component
// ============================================================================

export const DirectoryPickerModal: React.FC<DirectoryPickerModalProps> = ({
  isOpen,
  onSelect,
  onClose,
}) => {
  const { token, setWorkingDirectory } = useLocalBridgeStore();
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [tree, setTree] = useState<DirNode[]>([]);
  const [isLoadingHome, setIsLoadingHome] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const invokeToolOnBridge = useCallback(
    async (tool: string, params: Record<string, unknown>) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('http://localhost:9527/tools/invoke', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tool,
          params,
          requestId: crypto.randomUUID(),
        }),
      });
      if (!res.ok) throw new Error('桥接服务调用失败');
      return res.json();
    },
    [token]
  );

  const fetchHomeDir = useCallback(async () => {
    setIsLoadingHome(true);
    try {
      const data = await invokeToolOnBridge('system_info', {});
      const home = data?.result?.homeDir || data?.homeDir || '/';
      setHomeDir(home);
      return home;
    } catch {
      setHomeDir('/');
      return '/';
    } finally {
      setIsLoadingHome(false);
    }
  }, [invokeToolOnBridge]);

  const fetchDirectory = useCallback(
    async (path: string): Promise<DirNode[]> => {
      try {
        const data = await invokeToolOnBridge('directory_list', { path });
        const entries: Array<{ name: string; path: string; isDirectory: boolean }> =
          data?.result?.entries || data?.entries || [];
        return entries
          .filter((e) => e.isDirectory)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => ({
            name: e.name,
            path: e.path,
            children: null,
            isLoading: false,
            isExpanded: false,
          }));
      } catch {
        return [];
      }
    },
    [invokeToolOnBridge]
  );

  // Load initial tree when modal opens
  useEffect(() => {
    if (!isOpen) return;
    const init = async () => {
      const home = homeDir || (await fetchHomeDir());
      const children = await fetchDirectory(home);
      setTree(children);
    };
    init();
    // Reset selection on open
    setSelectedPath(null);
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleExpand = async (path: string) => {
    const updateNodes = async (nodes: DirNode[]): Promise<DirNode[]> => {
      return Promise.all(
        nodes.map(async (node) => {
          if (node.path === path) {
            if (node.isExpanded) {
              return { ...node, isExpanded: false };
            }
            if (node.children === null) {
              const children = await fetchDirectory(node.path);
              return { ...node, isExpanded: true, children };
            }
            return { ...node, isExpanded: true };
          }
          if (node.children) {
            return { ...node, children: await updateNodes(node.children) };
          }
          return node;
        })
      );
    };
    setTree(await updateNodes(tree));
  };

  const handleRefresh = async () => {
    const home = homeDir || (await fetchHomeDir());
    const children = await fetchDirectory(home);
    setTree(children);
  };

  const handleConfirm = () => {
    if (selectedPath) {
      setWorkingDirectory(selectedPath);
      onSelect(selectedPath);
    }
  };

  const renderNode = (node: DirNode, depth: number = 0) => (
    <div key={node.path}>
      <button
        onClick={() => {
          setSelectedPath(node.path);
          toggleExpand(node.path);
        }}
        className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-sm rounded transition-colors ${
          selectedPath === node.path
            ? 'bg-indigo-500/20 text-indigo-300'
            : 'text-zinc-300 hover:bg-zinc-700/50'
        }`}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {node.isExpanded ? (
          <ChevronDown className="w-3 h-3 text-zinc-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-zinc-500 flex-shrink-0" />
        )}
        {node.isExpanded ? (
          <FolderOpen className="w-4 h-4 text-yellow-400 flex-shrink-0" />
        ) : (
          <Folder className="w-4 h-4 text-zinc-400 flex-shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {node.isExpanded && node.children && (
        <div>
          {node.children.length === 0 ? (
            <div
              className="text-xs text-zinc-500 py-1"
              style={{ paddingLeft: `${(depth + 1) * 16 + 12}px` }}
            >
              (空目录)
            </div>
          ) : (
            node.children.map((child) => renderNode(child, depth + 1))
          )}
        </div>
      )}
    </div>
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 bg-zinc-900 rounded-2xl border border-zinc-700 shadow-2xl animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-700/50">
          <div className="flex items-center gap-2.5">
            <FolderTree className="w-5 h-5 text-indigo-400" />
            <h3 className="text-base font-medium text-zinc-200">
              选择工作目录
            </h3>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleRefresh}
              className="p-1.5 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="刷新"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Description */}
        <div className="px-5 py-3 border-b border-zinc-800">
          <p className="text-xs text-zinc-400 leading-relaxed">
            首次使用本地工具，请选择一个工作目录。AI 助手将在此目录下读写文件。
          </p>
        </div>

        {/* Directory Tree */}
        <div className="px-3 py-2 max-h-72 overflow-y-auto">
          {isLoadingHome ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
              <span className="ml-2 text-sm text-zinc-400">
                正在连接桥接服务...
              </span>
            </div>
          ) : tree.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-zinc-500">
              <Folder className="w-8 h-8 mb-2 opacity-50" />
              <span className="text-sm">无法加载目录</span>
              <span className="text-xs mt-1">请确认桥接服务已启动</span>
            </div>
          ) : (
            tree.map((node) => renderNode(node))
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-zinc-700/50">
          {/* Selected path display */}
          {selectedPath && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700">
              <span className="text-xs text-zinc-500">选中路径</span>
              <div className="text-sm text-indigo-300 font-mono truncate mt-0.5">
                {selectedPath}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={handleConfirm}
              disabled={!selectedPath}
            >
              确认
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
