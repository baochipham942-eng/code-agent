// ============================================================================
// ToolCallDisplay - Claude Code style tool execution display
// Single line header + result summary, expandable for details
// ============================================================================

import React, { useState, useMemo, useEffect } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { ToolCall } from '@shared/types';
import { useAppStore } from '../../../../../stores/appStore';
import { useSessionStore } from '../../../../../stores/sessionStore';
import { ToolHeader } from './ToolHeader';
import { ResultSummary } from './ResultSummary';
import { ToolDetails } from './ToolDetails';
import { getToolStatus, getStatusColor, type ToolStatus } from './styles';

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

  // Auto-collapse on success after 500ms
  useEffect(() => {
    if (status === 'success' && expanded) {
      const timer = setTimeout(() => setExpanded(false), 500);
      return () => clearTimeout(timer);
    }
  }, [status, expanded]);

  // Auto-expand on error or pending
  useEffect(() => {
    if (status === 'error' || status === 'pending') {
      setExpanded(true);
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
        onClick={() => setExpanded(!expanded)}
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

      {/* Expanded details */}
      {expanded && (
        <div className="animate-fadeIn">
          <ToolDetails toolCall={toolCall} compact={compact} />
        </div>
      )}
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
