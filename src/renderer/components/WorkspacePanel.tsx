// ============================================================================
// WorkspacePanel - File Explorer and Workspace View
// ============================================================================

import React, { useState, useEffect } from 'react';
import {
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileText,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  FolderPlus,
  Edit3,
} from 'lucide-react';

import type { FileInfo } from '@shared/types';
import { IPC_DOMAINS } from '@shared/ipc';
import { createLogger } from '../utils/logger';
import { isWebMode } from '../utils/platform';

const logger = createLogger('WorkspacePanel');

async function invokeWorkspace<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.WORKSPACE, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Workspace action failed: ${action}`);
  }
  return response.data as T;
}

interface FileTreeItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeItem[];
}

// Convert FileInfo[] to FileTreeItem[]
const convertToFileTree = (files: FileInfo[]): FileTreeItem[] => {
  return files.map(file => ({
    name: file.name,
    path: file.path,
    type: file.isDirectory ? 'directory' : 'file',
  }));
};

export const WorkspacePanel: React.FC = () => {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<FileTreeItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Load workspace on mount
  useEffect(() => {
    loadWorkspace();
  }, []);

  const loadWorkspace = async () => {
    setLoading(true);
    try {
      const path = await invokeWorkspace<string | null>('getCurrent');
      if (path) {
        setWorkspacePath(path);
        const files = await invokeWorkspace<FileInfo[]>('listFiles', { dirPath: path });
        setFileTree(files ? convertToFileTree(files) : []);
      }
    } catch (error) {
      logger.error('Failed to load workspace', error);
    } finally {
      setLoading(false);
    }
  };

  const selectWorkspace = async (manualPath?: string) => {
    try {
      if (isWebMode()) {
        if (!manualPath?.trim()) return;
        setWorkspacePath(manualPath.trim());
        const files = await invokeWorkspace<FileInfo[]>('listFiles', { dirPath: manualPath.trim() });
        setFileTree(files ? convertToFileTree(files) : []);
        return;
      }
      const path = await invokeWorkspace<string | null>('selectDirectory');
      if (path) {
        setWorkspacePath(path);
        const files = await invokeWorkspace<FileInfo[]>('listFiles', { dirPath: path });
        setFileTree(files ? convertToFileTree(files) : []);
      }
    } catch (error) {
      logger.error('Failed to select workspace', error);
    }
  };

  return (
    <div className="w-64 border-l border-zinc-700 bg-zinc-900 flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-zinc-700 flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-400">Workspace</span>
        <div className="flex items-center gap-1">
          <button
            onClick={loadWorkspace}
            disabled={loading}
            className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
{!isWebMode() && (
            <button
              onClick={() => selectWorkspace()}
              className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="Open folder"
            >
              <FolderPlus className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2">
        {!workspacePath ? (
<>
            {isWebMode() && (
              <WebPathInput onSubmit={(p) => selectWorkspace(p)} />
            )}
            <EmptyWorkspace onSelect={() => selectWorkspace()} isWeb={isWebMode()} />
          </>
        ) : (
          <div>
            {/* Workspace path */}
            <div className="text-xs text-zinc-500 px-2 py-1 truncate" title={workspacePath}>
              {workspacePath}
            </div>

            {/* File tree */}
            <div className="mt-2">
              {fileTree.map((item) => (
                <FileTreeNode key={item.path} item={item} level={0} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Empty workspace state
const EmptyWorkspace: React.FC<{ onSelect: () => void; isWeb?: boolean }> = ({ onSelect, isWeb }) => {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-4">
      <Folder className="w-12 h-12 text-zinc-600 mb-3" />
      <p className="text-sm text-zinc-400 mb-3">No workspace open</p>
{!isWeb && (
        <button
          onClick={onSelect}
          className="px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm text-zinc-400 transition-colors"
        >
          Open Folder
        </button>
      )}
    </div>
  );
};

// File tree node component
const FileTreeNode: React.FC<{ item: FileTreeItem; level: number }> = ({
  item,
  level,
}) => {
  const [expanded, setExpanded] = useState(false);

  const getFileIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'ts':
      case 'tsx':
      case 'js':
      case 'jsx':
        return <FileCode className="w-4 h-4 text-blue-400" />;
      case 'json':
      case 'yaml':
      case 'yml':
        return <FileCode className="w-4 h-4 text-yellow-400" />;
      case 'md':
      case 'txt':
        return <FileText className="w-4 h-4 text-zinc-400" />;
      case 'css':
      case 'scss':
        return <FileCode className="w-4 h-4 text-pink-400" />;
      default:
        return <File className="w-4 h-4 text-zinc-400" />;
    }
  };

  const handleClick = () => {
    if (item.type === 'directory') {
      setExpanded(!expanded);
    } else {
      // Open file in editor (future feature)
      logger.debug('Open file', { path: item.path });
    }
  };

  return (
    <div>
      <button
        onClick={handleClick}
        className="w-full flex items-center gap-1 px-2 py-1 rounded hover:bg-zinc-700 text-left transition-colors"
        style={{ paddingLeft: `${level * 12 + 8}px` }}
      >
        {/* Expand/collapse icon for directories */}
        {item.type === 'directory' ? (
          expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
          )
        ) : (
          <span className="w-3.5" />
        )}

        {/* Icon */}
        {item.type === 'directory' ? (
          expanded ? (
            <FolderOpen className="w-4 h-4 text-blue-400" />
          ) : (
            <Folder className="w-4 h-4 text-blue-400" />
          )
        ) : (
          getFileIcon(item.name)
        )}

        {/* Name */}
        <span className="text-sm text-zinc-400 truncate">{item.name}</span>
      </button>

      {/* Children */}
      {item.type === 'directory' && expanded && item.children && (
        <div>
          {item.children.map((child) => (
            <FileTreeNode key={child.path} item={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
};

/** Web mode: manual path input */
function WebPathInput({ onSubmit }: { onSubmit: (path: string) => void }) {
  const [value, setValue] = React.useState('');
  return (
    <div className="mb-3 flex gap-2 px-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit(value)}
        placeholder="输入工作目录路径"
        className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500"
      />
      <button
        onClick={() => onSubmit(value)}
        className="px-3 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm text-zinc-200 transition-colors"
      >
        打开
      </button>
    </div>
  );
}
