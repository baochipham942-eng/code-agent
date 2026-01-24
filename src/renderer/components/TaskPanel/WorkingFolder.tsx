// ============================================================================
// WorkingFolder - Display files being worked on
// ============================================================================

import React, { useState, useMemo } from 'react';
import { FileText, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';

interface FileInfo {
  path: string;
  name: string;
}

export const WorkingFolder: React.FC = () => {
  const { workingDirectory } = useAppStore();
  const { messages } = useSessionStore();
  const [expanded, setExpanded] = useState(true);

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

  return (
    <div className="bg-zinc-800/30 rounded-lg p-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full mb-2"
      >
        <div className="flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            Working folder
          </span>
        </div>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
        )}
      </button>

      {expanded && (
        <div className="space-y-1">
          {/* Workspace path */}
          <div className="text-xs text-zinc-500 mb-2 truncate" title={workingDirectory || ''}>
            {workingDirectory || 'No workspace selected'}
          </div>

          {/* Recent files */}
          {recentFiles.length > 0 ? (
            recentFiles.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-2 py-1 px-2 rounded hover:bg-zinc-800/50 transition-colors cursor-pointer"
                title={file.path}
              >
                <FileText className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-sm text-zinc-300 truncate">{file.name}</span>
              </div>
            ))
          ) : (
            <div className="text-xs text-zinc-600 py-2">No recent files</div>
          )}
        </div>
      )}
    </div>
  );
};
