// ============================================================================
// WorkingDirectoryPicker - Directory Tree Browser for Bridge Working Dir
// ============================================================================

import React, { useState, useCallback } from 'react';
import { Folder, FolderOpen, ChevronRight, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { useLocalBridgeStore } from '../../../../../stores/localBridgeStore';
import { Button } from '../../../../primitives';

// ============================================================================
// Types
// ============================================================================

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
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

export const WorkingDirectoryPicker: React.FC = () => {
  const { workingDirectory, setWorkingDirectory, token } = useLocalBridgeStore();
  const [showPicker, setShowPicker] = useState(false);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [tree, setTree] = useState<DirNode[]>([]);
  const [isLoadingHome, setIsLoadingHome] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const invokeToolOnBridge = useCallback(async (tool: string, params: Record<string, any>) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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
  }, [token]);

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

  const fetchDirectory = useCallback(async (path: string): Promise<DirNode[]> => {
    try {
      const data = await invokeToolOnBridge('directory_list', { path });
      const entries: DirEntry[] = data?.result?.entries || data?.entries || [];
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
  }, [invokeToolOnBridge]);

  const handleOpenPicker = async () => {
    setShowPicker(true);
    const home = homeDir || (await fetchHomeDir());
    const children = await fetchDirectory(home);
    setTree(children);
  };

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

  const handleSelect = () => {
    if (selectedPath) {
      setWorkingDirectory(selectedPath);
      setShowPicker(false);
    }
  };

  const renderNode = (node: DirNode, depth: number = 0) => (
    <div key={node.path}>
      <button
        onClick={() => {
          setSelectedPath(node.path);
          toggleExpand(node.path);
        }}
        className={`w-full flex items-center gap-1.5 px-2 py-1 text-left text-sm rounded transition-colors ${
          selectedPath === node.path
            ? 'bg-indigo-500/20 text-indigo-300'
            : 'text-zinc-300 hover:bg-zinc-700'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
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
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
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

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs text-zinc-400">工作目录</span>
          <div className="text-sm text-zinc-200 font-mono mt-0.5">
            {workingDirectory || '未设置'}
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={handleOpenPicker}>
          {workingDirectory ? '更换' : '选择'}
        </Button>
      </div>

      {showPicker && (
        <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-zinc-400">选择工作目录</span>
            <button
              onClick={handleOpenPicker}
              className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="刷新"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {isLoadingHome ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
              </div>
            ) : (
              tree.map((node) => renderNode(node))
            )}
          </div>
          <div className="flex justify-end gap-2 mt-3 pt-2 border-t border-zinc-700">
            <Button size="sm" variant="ghost" onClick={() => setShowPicker(false)}>
              取消
            </Button>
            <Button size="sm" variant="primary" onClick={handleSelect} disabled={!selectedPath}>
              确认
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
