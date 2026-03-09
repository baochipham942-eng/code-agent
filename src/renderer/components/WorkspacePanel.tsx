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
} from 'lucide-react';

import type { FileInfo } from '@shared/types';
import { createLogger } from '../utils/logger';

const logger = createLogger('WorkspacePanel');

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
      const path = await window.electronAPI?.invoke('workspace:get-current');
      if (path) {
        setWorkspacePath(path as string);
        const files = await window.electronAPI?.invoke('workspace:list-files', path as string);
        setFileTree(files ? convertToFileTree(files as FileInfo[]) : []);
      }
    } catch (error) {
      logger.error('Failed to load workspace', error);
    } finally {
      setLoading(false);
    }
  };

  const selectWorkspace = async () => {
    try {
      const path = await window.electronAPI?.invoke('workspace:select-directory');
      if (path) {
        setWorkspacePath(path as string);
        const files = await window.electronAPI?.invoke('workspace:list-files', path as string);
        setFileTree(files ? convertToFileTree(files as FileInfo[]) : []);
      }
    } catch (error) {
      logger.error('Failed to select workspace', error);
    }
  };

  return (
    <div className="w-64 border-l border-border-default bg-deep flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-border-default flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">Workspace</span>
        <div className="flex items-center gap-1">
          <button
            onClick={loadWorkspace}
            disabled={loading}
            className="p-1 rounded hover:bg-hover text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={selectWorkspace}
            className="p-1 rounded hover:bg-hover text-text-secondary hover:text-text-primary transition-colors"
            title="Open folder"
          >
            <FolderPlus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2">
        {!workspacePath ? (
          <EmptyWorkspace onSelect={selectWorkspace} />
        ) : (
          <div>
            {/* Workspace path */}
            <div className="text-xs text-text-tertiary px-2 py-1 truncate" title={workspacePath}>
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
const EmptyWorkspace: React.FC<{ onSelect: () => void }> = ({ onSelect }) => {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-4">
      <Folder className="w-12 h-12 text-text-disabled mb-3" />
      <p className="text-sm text-text-secondary mb-3">No workspace open</p>
      <button
        onClick={onSelect}
        className="px-3 py-1.5 rounded-lg bg-elevated hover:bg-active text-sm text-text-secondary transition-colors"
      >
        Open Folder
      </button>
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
        return <FileText className="w-4 h-4 text-text-secondary" />;
      case 'css':
      case 'scss':
        return <FileCode className="w-4 h-4 text-pink-400" />;
      default:
        return <File className="w-4 h-4 text-text-secondary" />;
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
        className="w-full flex items-center gap-1 px-2 py-1 rounded hover:bg-hover text-left transition-colors"
        style={{ paddingLeft: `${level * 12 + 8}px` }}
      >
        {/* Expand/collapse icon for directories */}
        {item.type === 'directory' ? (
          expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-text-tertiary" />
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
        <span className="text-sm text-text-secondary truncate">{item.name}</span>
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
