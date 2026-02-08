// ============================================================================
// ToolCallDisplay - Claude Code terminal style tool execution display
// StatusIndicator (braille spinner) + ToolName + params + ⎿ result summary
// ============================================================================

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { FileText, ExternalLink, Folder } from 'lucide-react';
import type { ToolCall } from '@shared/types';
import { useAppStore } from '../../../../../stores/appStore';
import { useSessionStore } from '../../../../../stores/sessionStore';
import { ToolHeader } from './ToolHeader';
import { ResultSummary } from './ResultSummary';
import { ToolDetails } from './ToolDetails';
import { getToolStatus, getStatusColor, type ToolStatus } from './styles';

// ============================================================================
// StatusIndicator - Braille spinner for pending, symbols for final states
// ============================================================================

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function StatusIndicator({ status }: { status: ToolStatus }) {
  const [frame, setFrame] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (status === 'pending') {
      intervalRef.current = setInterval(() => {
        setFrame((f) => (f + 1) % BRAILLE_FRAMES.length);
      }, 80);
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }
    // Clear interval when status changes away from pending
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, [status]);

  const statusColor = getStatusColor(status);

  switch (status) {
    case 'pending':
      return (
        <span className={`w-4 flex-shrink-0 text-center font-mono ${statusColor.dot}`}>
          {BRAILLE_FRAMES[frame]}
        </span>
      );
    case 'success':
      return (
        <span className={`w-4 flex-shrink-0 text-center ${statusColor.dot}`}>
          ●
        </span>
      );
    case 'error':
      return (
        <span className={`w-4 flex-shrink-0 text-center font-bold ${statusColor.dot}`}>
          ✗
        </span>
      );
    case 'interrupted':
      return (
        <span className={`w-4 flex-shrink-0 text-center ${statusColor.dot}`}>
          ○
        </span>
      );
  }
}

// Extract file path from write_file tool call result
function extractWriteFilePath(toolCall: ToolCall): string | null {
  if (toolCall.name !== 'write_file') return null;
  if (toolCall.result && !toolCall.result.success) return null;

  const output = toolCall.result?.output as string;
  if (output) {
    const match = output.match(/(?:Created|Updated) file: (.+?)(?:\s+\(|\n|$)/);
    if (match) return match[1].trim();
  }

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
  // Track if user manually toggled
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
      setUserToggled(false);
    }
  }, [status]);

  return (
    <div
      className={`font-mono text-sm ${
        status === 'error' ? 'border-l-2 border-[var(--cc-error)] pl-2' : ''
      }`}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Main row: [StatusIndicator] [ToolName bold] [params muted] [duration right] */}
      <div
        className="flex items-center gap-1.5 cursor-pointer hover:bg-zinc-800/50 rounded px-1 py-0.5 transition-colors"
        onClick={() => {
          setExpanded(!expanded);
          setUserToggled(true);
        }}
      >
        <StatusIndicator status={status} />
        <ToolHeader toolCall={toolCall} status={status} />
      </div>

      {/* Result summary line with ⎿ connector - only when collapsed and has result */}
      {toolCall.result && !expanded && <ResultSummary toolCall={toolCall} />}

      {/* Quick file actions for write_file - shown when collapsed */}
      {!expanded && status === 'success' && toolCall.name === 'write_file' && (
        <QuickFileActions filePath={extractWriteFilePath(toolCall)} />
      )}

      {/* Expanded details - indented under tool name (ml-5 aligns with text after StatusIndicator) */}
      {expanded && (
        <div className="ml-5 animate-fadeIn">
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
    <div className="ml-5 mt-1 flex items-center gap-2">
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
// Compact Version for Cowork Mode (kept for backward compatibility)
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
