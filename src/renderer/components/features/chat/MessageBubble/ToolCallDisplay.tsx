// ============================================================================
// ToolCallDisplay - Display tool call execution and results
// ============================================================================

import React, { useState, useMemo } from 'react';
import {
  ChevronRight,
  Terminal,
  FileText,
  FileEdit,
  FolderSearch,
  Globe,
  Zap,
  Sparkles,
  Code2,
  Check,
  AlertCircle,
  Play,
  Clock,
} from 'lucide-react';
import type { ToolCallDisplayProps, ToolStatus, ToolStatusConfig } from './types';
import type { ToolCall } from '@shared/types';
import { useAppStore } from '../../../../stores/appStore';
import { summarizeToolCall, getToolIcon as getToolIconEmoji, getToolStatusText, getToolStatusClass } from '../../../../utils/toolSummary';
import { DiffView, DiffPreview } from '../../../DiffView';

// Tool icon mapping
const getToolIcon = (name: string): React.ReactNode => {
  const iconMap: Record<string, React.ReactNode> = {
    bash: <Terminal className="w-3.5 h-3.5" />,
    read_file: <FileText className="w-3.5 h-3.5" />,
    write_file: <FileEdit className="w-3.5 h-3.5" />,
    edit_file: <FileEdit className="w-3.5 h-3.5" />,
    glob: <FolderSearch className="w-3.5 h-3.5" />,
    grep: <FolderSearch className="w-3.5 h-3.5" />,
    list_directory: <FolderSearch className="w-3.5 h-3.5" />,
    web_fetch: <Globe className="w-3.5 h-3.5" />,
    task: <Zap className="w-3.5 h-3.5" />,
    skill: <Sparkles className="w-3.5 h-3.5" />,
  };
  return iconMap[name] || <Code2 className="w-3.5 h-3.5" />;
};

// Loader component for pending state
const Loader: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
  </svg>
);

// Status config
const statusConfig: Record<ToolStatus, ToolStatusConfig> = {
  success: {
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-400',
    border: 'border-emerald-500/20',
    icon: <Check className="w-3 h-3" />,
    label: 'Success'
  },
  error: {
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    border: 'border-red-500/20',
    icon: <AlertCircle className="w-3 h-3" />,
    label: 'Error'
  },
  pending: {
    bg: 'bg-amber-500/10',
    text: 'text-amber-400',
    border: 'border-amber-500/20',
    icon: <Loader className="w-3 h-3 animate-spin" />,
    label: 'Running'
  }
};

// Main tool call display component
export const ToolCallDisplay: React.FC<ToolCallDisplayProps> = ({
  toolCall,
  index,
  total
}) => {
  // Default collapsed, only expand when running or error
  const [expanded, setExpanded] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const openPreview = useAppStore((state) => state.openPreview);

  // Get status from result
  const getStatus = (): ToolStatus => {
    if (!toolCall.result) return 'pending';
    return toolCall.result.success ? 'success' : 'error';
  };

  const status = getStatus();

  // Generate tool summary
  const summary = useMemo(() => summarizeToolCall(toolCall), [toolCall]);
  const toolIcon = useMemo(() => getToolIconEmoji(toolCall.name), [toolCall.name]);
  const statusText = useMemo(() => getToolStatusText(toolCall), [toolCall]);

  // Check if this is edit_file tool call
  const isEditFile = toolCall.name === 'edit_file';
  const editFileArgs = isEditFile ? {
    filePath: (toolCall.arguments?.file_path as string) || '',
    oldString: (toolCall.arguments?.old_string as string) || '',
    newString: (toolCall.arguments?.new_string as string) || '',
  } : null;

  // Check if this is an HTML file creation
  const getHtmlFilePath = (): string | null => {
    if (toolCall.name === 'write_file' && toolCall.result?.success) {
      // Prefer extracting the absolute path from result output
      const output = toolCall.result?.output as string;
      if (output && output.includes('.html')) {
        const match = output.match(/(?:Created|Updated) file: (.+\.html)/);
        if (match) return match[1];
      }
      // Fallback to arguments
      const filePath = toolCall.arguments?.file_path as string;
      if (filePath && filePath.endsWith('.html')) {
        return filePath;
      }
    }
    return null;
  };

  const config = statusConfig[status];
  const htmlFilePath = getHtmlFilePath();

  return (
    <div
      className={`rounded-xl bg-zinc-800/40 border border-zinc-700/50 overflow-hidden transition-all duration-200 ${
        expanded ? 'shadow-lg' : ''
      }`}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      {/* Header - show summary instead of tool name */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-700/20 transition-all duration-200"
      >
        {/* Expand indicator */}
        <div className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}>
          <ChevronRight className="w-4 h-4 text-zinc-500" />
        </div>

        {/* Tool icon with emoji */}
        <div className={`p-2 rounded-lg ${config.bg} text-lg`}>
          <span>{toolIcon}</span>
        </div>

        {/* Tool summary */}
        <div className="flex-1 text-left min-w-0">
          <div className="text-sm font-medium text-zinc-200 truncate">{summary}</div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="font-mono">{toolCall.name}</span>
            {total > 1 && <span className="text-zinc-600">#{index + 1}</span>}
          </div>
        </div>

        {/* Diff preview for edit_file */}
        {isEditFile && editFileArgs && (
          <DiffPreview
            oldText={editFileArgs.oldString}
            newText={editFileArgs.newString}
            onClick={(e) => {
              e?.stopPropagation?.();
              setShowDiff(true);
              setExpanded(true);
            }}
          />
        )}

        {/* Preview button for HTML files */}
        {htmlFilePath && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              openPreview(htmlFilePath);
            }}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 text-xs transition-colors border border-blue-500/30"
            title="在右侧预览"
          >
            <Play className="w-3 h-3" />
            预览
          </button>
        )}

        {/* Status badge with duration */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text} ${config.border} border`}>
          {config.icon}
          <span>{statusText}</span>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 pt-2 border-t border-zinc-700/30 animate-fadeIn">
          {/* Diff view for edit_file */}
          {isEditFile && editFileArgs && showDiff && (
            <div className="mb-3">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 mb-2">
                <span>Changes</span>
                <div className="flex-1 h-px bg-zinc-700/50" />
                <button
                  onClick={() => setShowDiff(false)}
                  className="text-zinc-500 hover:text-zinc-300 px-2"
                >
                  隐藏
                </button>
              </div>
              <DiffView
                oldText={editFileArgs.oldString}
                newText={editFileArgs.newString}
                fileName={editFileArgs.filePath.split('/').pop()}
                className="border border-zinc-700/50"
              />
            </div>
          )}

          {/* Arguments - simplified for edit_file */}
          <div className="mb-3">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 mb-2">
              <span>Arguments</span>
              <div className="flex-1 h-px bg-zinc-700/50" />
              {isEditFile && !showDiff && (
                <button
                  onClick={() => setShowDiff(true)}
                  className="text-primary-400 hover:text-primary-300 px-2"
                >
                  查看差异
                </button>
              )}
            </div>
            <pre className="text-xs text-zinc-400 bg-zinc-900/50 rounded-lg p-3 overflow-x-auto border border-zinc-800/50">
              {isEditFile && editFileArgs ? (
                // Simplified display for edit_file arguments
                JSON.stringify({
                  file_path: editFileArgs.filePath,
                  old_string: editFileArgs.oldString.length > 100
                    ? `${editFileArgs.oldString.slice(0, 100)}... (${editFileArgs.oldString.length} chars)`
                    : editFileArgs.oldString,
                  new_string: editFileArgs.newString.length > 100
                    ? `${editFileArgs.newString.slice(0, 100)}... (${editFileArgs.newString.length} chars)`
                    : editFileArgs.newString,
                }, null, 2)
              ) : (
                JSON.stringify(toolCall.arguments, null, 2)
              )}
            </pre>
          </div>

          {/* Result */}
          {toolCall.result && (
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 mb-2">
                <span>Result</span>
                <div className="flex-1 h-px bg-zinc-700/50" />
                {toolCall.result.duration && (
                  <span className="flex items-center gap-1 text-zinc-600">
                    <Clock className="w-3 h-3" />
                    {toolCall.result.duration < 1000
                      ? `${toolCall.result.duration}ms`
                      : `${(toolCall.result.duration / 1000).toFixed(1)}s`
                    }
                  </span>
                )}
              </div>
              <pre className={`text-xs bg-zinc-900/50 rounded-lg p-3 overflow-x-auto max-h-48 border ${
                status === 'error'
                  ? 'text-red-300 border-red-500/20'
                  : 'text-zinc-400 border-zinc-800/50'
              }`}>
                {toolCall.result.error
                  ? toolCall.result.error
                  : typeof toolCall.result.output === 'string'
                    ? toolCall.result.output
                    : JSON.stringify(toolCall.result.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
