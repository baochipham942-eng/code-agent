// ============================================================================
// WorkingFolder - Display files being worked on
// ============================================================================

import React, { useState, useMemo } from 'react';
import { FileText, FolderOpen, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useI18n } from '../../hooks/useI18n';
import { IPC_CHANNELS } from '@shared/ipc';

interface FileInfo {
  path: string;
  name: string;
}

export const WorkingFolder: React.FC = () => {
  const { workingDirectory, setWorkingDirectory } = useAppStore();
  const { messages } = useSessionStore();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);

  // Infer working directory from generated files if not set
  const inferredDirectory = useMemo(() => {
    if (workingDirectory) return null; // Already set, no need to infer

    // Look for file paths in recent tool calls
    for (const message of messages.slice(-20).reverse()) {
      if (message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          if (['write_file', 'edit_file', 'read_file'].includes(toolCall.name)) {
            const args = toolCall.arguments as Record<string, unknown>;
            const filePath = (args?.path || args?.file_path) as string | undefined;
            if (filePath && filePath.startsWith('/')) {
              // Extract directory from file path
              const lastSlash = filePath.lastIndexOf('/');
              if (lastSlash > 0) {
                return filePath.substring(0, lastSlash);
              }
            }
          }
        }
      }
    }
    return null;
  }, [workingDirectory, messages]);

  // Auto-set working directory if inferred
  React.useEffect(() => {
    if (inferredDirectory && !workingDirectory) {
      setWorkingDirectory(inferredDirectory);
    }
  }, [inferredDirectory, workingDirectory, setWorkingDirectory]);

  // Extract file paths from tool calls in messages
  const recentFiles = useMemo(() => {
    const files: FileInfo[] = [];
    const seenPaths = new Set<string>();

    // Look at recent messages for file-related tool calls
    for (const message of messages.slice(-20).reverse()) {
      if (message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          // Check for file-related tools
          if (['read_file', 'write_file', 'edit_file'].includes(toolCall.name)) {
            const args = toolCall.arguments as Record<string, unknown>;
            const filePath = (args?.path || args?.file_path) as string | undefined;
            if (filePath && !seenPaths.has(filePath)) {
              seenPaths.add(filePath);
              const name = filePath.split('/').pop() || filePath;
              files.push({ path: filePath, name });
              if (files.length >= 5) break;
            }
          }
        }
      }
      if (files.length >= 5) break;
    }

    return files;
  }, [messages]);

  const handleSelectDirectory = async () => {
    try {
      const result = await window.electronAPI?.invoke(IPC_CHANNELS.WORKSPACE_SELECT_DIRECTORY);
      if (result) {
        setWorkingDirectory(result);
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    }
  };

  const handleOpenInFinder = async (filePath: string) => {
    try {
      // Use showItemInFolder to reveal the file in Finder
      await window.electronAPI?.invoke(IPC_CHANNELS.SHELL_OPEN_PATH, filePath);
    } catch (error) {
      console.error('Failed to open in Finder:', error);
    }
  };

  return (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl p-3 border border-white/[0.04]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center w-full"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FolderOpen className="w-4 h-4 text-amber-400 flex-shrink-0" />
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            {t.taskPanel.workingFolder}
          </span>
        </div>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="space-y-1 mt-3">
          {/* Workspace path or select button */}
          {workingDirectory ? (
            <div
              className="text-xs text-zinc-500 mb-2 truncate cursor-pointer hover:text-zinc-300 transition-colors"
              title={workingDirectory}
              onClick={() => handleOpenInFinder(workingDirectory)}
            >
              {workingDirectory.split('/').slice(-3).join('/')}
            </div>
          ) : (
            <button
              onClick={handleSelectDirectory}
              className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 mb-2 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t.taskPanel.noWorkspace}</span>
            </button>
          )}

          {/* Recent files */}
          {recentFiles.length > 0 ? (
            recentFiles.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-2 py-1 px-2 rounded hover:bg-zinc-800/50 transition-colors cursor-pointer"
                title={file.path}
                onClick={() => handleOpenInFinder(file.path)}
              >
                <FileText className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-sm text-zinc-300 truncate">{file.name}</span>
              </div>
            ))
          ) : (
            <div className="text-xs text-zinc-600 py-2">{t.taskPanel.noRecentFiles}</div>
          )}
        </div>
      )}
    </div>
  );
};
