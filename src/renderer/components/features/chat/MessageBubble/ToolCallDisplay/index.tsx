// ============================================================================
// ToolCallDisplay - Claude Code style tool execution display
// Single line header + result summary, expandable for details
// ============================================================================

import React, { useState, useMemo, useEffect } from 'react';
import { ChevronRight, ChevronDown, FileText, ExternalLink, Folder } from 'lucide-react';
import type { ToolCall } from '@shared/types';
import { useAppStore } from '../../../../../stores/appStore';
import { useSessionStore } from '../../../../../stores/sessionStore';
import { ToolHeader } from './ToolHeader';
import { ResultSummary } from './ResultSummary';
import { ToolDetails } from './ToolDetails';
import { getToolStatus, getStatusColor, type ToolStatus } from './styles';

// Extract file path from write_file tool call result
function extractWriteFilePath(toolCall: ToolCall): string | null {
  if (toolCall.name !== 'write_file') return null;
  if (toolCall.result && !toolCall.result.success) return null;

  // Try to extract from result output first (has absolute path)
  const output = toolCall.result?.output as string;
  if (output) {
    const match = output.match(/(?:Created|Updated) file: (.+?)(?:\s+\(|\n|$)/);
    if (match) return match[1].trim();
  }

  // Fallback to arguments.file_path
  return (toolCall.arguments?.file_path as string) || null;
}

interface ToolCallDisplayProps {
  toolCall: ToolCall;
  index: number;
  total: number;
  /** Compact mode for Cowork display - simplified view */
  compact?: boolean;
}

export function ToolCallDisplay({
  toolCall,
  index,
  total,
  compact = false,
}: ToolCallDisplayProps) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const processingSessionIds = useAppStore(
    (state) => state.processingSessionIds
  );

  // Calculate status
  const status: ToolStatus = useMemo(() => {
    return getToolStatus(toolCall, currentSessionId, processingSessionIds);
  }, [toolCall, currentSessionId, processingSessionIds]);

  // Default expanded state: error or pending shows expanded, success/interrupted collapsed
  const [expanded, setExpanded] = useState(
    status === 'error' || status === 'pending'
  );
  // Track if user manually toggled - prevents auto-collapse from overriding user action
  const [userToggled, setUserToggled] = useState(false);

  // Auto-collapse on success after 500ms (only if user hasn't manually toggled)
  useEffect(() => {
    if (status === 'success' && expanded && !userToggled) {
      const timer = setTimeout(() => setExpanded(false), 500);
      return () => clearTimeout(timer);
    }
  }, [status, expanded, userToggled]);

  // Auto-expand on error or pending
  useEffect(() => {
    if (status === 'error' || status === 'pending') {
      setExpanded(true);
      setUserToggled(false); // Reset user toggle on status change
    }
  }, [status]);

  const statusColor = getStatusColor(status);

  return (
    <div
      className={`my-1 font-mono text-sm ${
        status === 'error' ? 'border-l-2 border-red-500 pl-2' : ''
      }`}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Main row - clickable to expand/collapse */}
      <div
        className="flex items-center gap-2 cursor-pointer hover:bg-gray-800/50 rounded px-1 py-0.5 transition-colors"
        onClick={() => {
          setExpanded(!expanded);
          setUserToggled(true);
        }}
      >
        {/* Expand/collapse indicator */}
        <span className="text-gray-500 w-4 flex-shrink-0">
          {expanded ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
        </span>

        {/* Status dot */}
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor.dot}`} />

        {/* Tool header info */}
        <ToolHeader toolCall={toolCall} status={status} />
      </div>

      {/* Result summary line - only when collapsed and has result */}
      {toolCall.result && !expanded && <ResultSummary toolCall={toolCall} />}

      {/* Quick file actions for write_file - shown when collapsed */}
      {!expanded && status === 'success' && toolCall.name === 'write_file' && (
        <QuickFileActions filePath={extractWriteFilePath(toolCall)} />
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="animate-fadeIn">
          <ToolDetails toolCall={toolCall} compact={compact} />
        </div>
      )}
    </div>
  );
}

// Quick file actions component - shown inline when write_file is collapsed
function QuickFileActions({ filePath }: { filePath: string | null }) {
  if (!filePath) return null;

  const fileName = filePath.split('/').pop() || filePath;
  const isHtml = filePath.toLowerCase().endsWith('.html') || filePath.toLowerCase().endsWith('.htm');
  const openPreview = useAppStore((state) => state.openPreview);

  const handleOpenFile = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.domainAPI?.invoke('workspace', 'openPath', { filePath });
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  const handleShowInFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.domainAPI?.invoke('workspace', 'showItemInFolder', { filePath });
    } catch (error) {
      console.error('Failed to show in folder:', error);
    }
  };

  const handlePreview = (e: React.MouseEvent) => {
    e.stopPropagation();
    openPreview(filePath);
  };

  return (
    <div className="ml-8 mt-1 flex items-center gap-2">
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
        <FileText className="w-3 h-3" />
        <span className="truncate max-w-[200px]" title={filePath}>{fileName}</span>
      </div>
      <div className="flex items-center gap-1">
        {isHtml && (
          <button
            onClick={handlePreview}
            className="p-1 rounded hover:bg-gray-700/50 text-blue-400 hover:text-blue-300 transition-colors"
            title="预览"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={handleOpenFile}
          className="p-1 rounded hover:bg-gray-700/50 text-gray-400 hover:text-gray-300 transition-colors"
          title="打开文件"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleShowInFolder}
          className="p-1 rounded hover:bg-gray-700/50 text-gray-400 hover:text-gray-300 transition-colors"
          title="在 Finder 中显示"
        >
          <Folder className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Compact Version for Cowork Mode
// ============================================================================

export function ToolCallDisplayCompact({
  toolCall,
  index,
  total,
}: Omit<ToolCallDisplayProps, 'compact'>) {
  return (
    <ToolCallDisplay
      toolCall={toolCall}
      index={index}
      total={total}
      compact={true}
    />
  );
}

// Re-export types and utilities
export type { ToolStatus } from './styles';
export { getToolStatus, getStatusColor } from './styles';
export { getToolIcon, formatParams, formatDuration, getToolDisplayName } from './utils';
export { summarizeTool } from './summarizers';
