// ============================================================================
// ToolCallDisplay - Claude Code terminal style tool execution display
// StatusIndicator (braille spinner) + ToolName + params + ⎿ result summary
// ============================================================================

import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { ToolCall } from '@shared/contract';
import { useAppStore } from '../../../../../stores/appStore';
import { useSessionStore } from '../../../../../stores/sessionStore';
import { ToolHeader } from './ToolHeader';
import { ResultSummary } from './ResultSummary';
import { ToolDetails } from './ToolDetails';
import { getToolStatus, getStatusColor, type ToolStatus } from './styles';
import {
  buildBrowserComputerActionPreview,
  type BrowserComputerActionPreview,
} from '../../../../../utils/browserComputerActionPreview';
import {
  formatToolDuration,
  getToolCapabilitySource,
  getToolPermissionView,
  getToolRecoveryHint,
  type ToolPermissionView,
} from '../../../../../utils/toolExecutionPresentation';
import type { ToolCapabilitySource } from '../../../../../types/runWorkbench';

// ============================================================================
// StatusIndicator - Braille spinner for pending, symbols for final states
// ============================================================================

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAME_INTERVAL_MS = 240;

function StatusIndicator({ status }: { status: ToolStatus }) {
  const [frame, setFrame] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (status === 'pending') {
      intervalRef.current = setInterval(() => {
        setFrame((f) => (f + 1) % BRAILLE_FRAMES.length);
      }, SPINNER_FRAME_INTERVAL_MS);
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
  total: _total,
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
  // 默认折叠，仅 error 时自动展开
  const [expanded, setExpanded] = useState(
    status === 'error'
  );
  // Track if user manually toggled
  const [userToggled, setUserToggled] = useState(false);
  const actionPreview = useMemo(
    () => buildBrowserComputerActionPreview(toolCall),
    [toolCall],
  );

  // Auto-collapse on success after 500ms (only if user hasn't manually toggled)
  useEffect(() => {
    if (status === 'success' && expanded && !userToggled) {
      const timer = setTimeout(() => setExpanded(false), 500);
      return () => clearTimeout(timer);
    }
  }, [status, expanded, userToggled]);

  // Auto-expand on error or pending
  useEffect(() => {
    if (status === 'error') {
      setExpanded(true);
      setUserToggled(false);
    }
  }, [status]);

  return (
    <div
      className={`group font-mono text-sm ${
        status === 'error' ? 'border-l-2 border-[var(--cc-error)] pl-2' : ''
      }`}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Main row: [StatusIndicator] [ToolName bold] [params muted] [inline file badge for Write] */}
      <div
        className="group/row flex items-center gap-1.5 cursor-pointer hover:bg-zinc-800 rounded px-1 py-0.5 transition-colors"
        onClick={() => {
          setExpanded(!expanded);
          setUserToggled(true);
        }}
      >
        <StatusIndicator status={status} />
        <ToolHeader toolCall={toolCall} status={status} />
      </div>

      {actionPreview && (
        <BrowserComputerActionPreviewLine preview={actionPreview} />
      )}

      {!compact && (expanded || status !== 'success') && (
        <ToolExecutionMetaRow toolCall={toolCall} status={status} />
      )}

      {/* Bash inline output - when collapsed, show command output preview */}
      {!expanded && isBashTool(toolCall) && toolCall.result && (
        <BashOutputPreview toolCall={toolCall} status={status} />
      )}

      {/* Result summary line - hidden by default, show on hover or when expanded */}
      {toolCall.result && !expanded && !isBashTool(toolCall) && (
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          <ResultSummary toolCall={toolCall} />
        </div>
      )}

      {/* Expanded details - indented under tool name */}
      {expanded && (
        <div className="ml-6 animate-fadeIn">
          <ToolDetails toolCall={toolCall} compact={compact} />
        </div>
      )}
    </div>
  );
}

function getSourceToneClass(source: ToolCapabilitySource): string {
  switch (source) {
    case 'mcp':
      return 'border-cyan-500/20 bg-cyan-500/10 text-cyan-300';
    case 'skill':
      return 'border-violet-500/20 bg-violet-500/10 text-violet-300';
    case 'connector':
      return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300';
    case 'computer':
      return 'border-amber-500/20 bg-amber-500/10 text-amber-300';
    case 'memory':
      return 'border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-300';
    default:
      return 'border-white/[0.08] bg-white/[0.03] text-zinc-400';
  }
}

function getPermissionToneClass(permission: ToolPermissionView): string {
  switch (permission) {
    case 'read':
      return 'text-emerald-300';
    case 'write':
    case 'shell':
    case 'desktop':
      return 'text-amber-300';
    case 'network':
    case 'mcp':
      return 'text-sky-300';
    case 'memory':
      return 'text-fuchsia-300';
    default:
      return 'text-zinc-500';
  }
}

function getStatusLabel(status: ToolStatus): string {
  switch (status) {
    case 'pending':
      return 'running';
    case 'success':
      return 'completed';
    case 'error':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
  }
}

const ToolExecutionMetaRow: React.FC<{ toolCall: ToolCall; status: ToolStatus }> = ({ toolCall, status }) => {
  const source = getToolCapabilitySource(toolCall.name);
  const permission = getToolPermissionView(toolCall.name);
  const duration = formatToolDuration(toolCall.result?.duration);
  const recoveryHint = getToolRecoveryHint(toolCall, status);

  return (
    <div className="ml-6 mt-0.5 mb-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
      <span className={`rounded border px-1.5 py-0.5 ${getSourceToneClass(source)}`}>{source}</span>
      <span className={getPermissionToneClass(permission)}>{permission}</span>
      <span>{getStatusLabel(status)}</span>
      {duration && <span>{duration}</span>}
      <span className={status === 'error' ? 'text-red-300' : 'text-zinc-600'}>{recoveryHint}</span>
    </div>
  );
};

function getActionPreviewRiskClass(risk: BrowserComputerActionPreview['risk']): string {
  switch (risk) {
    case 'read':
      return 'text-emerald-300';
    case 'browser_action':
      return 'text-sky-300';
    case 'desktop_input':
      return 'text-amber-300';
    default:
      return 'text-zinc-400';
  }
}

function BrowserComputerActionPreviewLine({ preview }: { preview: BrowserComputerActionPreview }) {
  return (
    <div className="ml-6 mt-0.5 mb-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
      <span className="text-zinc-600">Action</span>
      <span className="text-zinc-300">{preview.summary}</span>
      {preview.target && (
        <>
          <span className="text-zinc-700">→</span>
          <span className="max-w-[320px] truncate" title={preview.target}>{preview.target}</span>
        </>
      )}
      <span className={getActionPreviewRiskClass(preview.risk)}>{preview.riskLabel}</span>
      {preview.mode && <span title={preview.mode}>{preview.mode}</span>}
      {preview.traceId && <span className="font-mono" title={preview.traceId}>{preview.traceId}</span>}
    </div>
  );
}

// ============================================================================
// Bash Output Preview - inline output when Bash is collapsed
// Pending: last 5 lines (streaming feel)
// Completed: first 20 lines + "...+N lines" if truncated
// ============================================================================

const BASH_PREVIEW_LINES_PENDING = 5;
const BASH_PREVIEW_LINES_COMPLETED = 20;
const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`\u001b\[[0-9;]*[a-zA-Z]|\u001b\].*?\u0007|\u001b\[[?]?[0-9;]*[a-zA-Z]`,
  'g',
);

function isBashTool(toolCall: ToolCall): boolean {
  return toolCall.name === 'Bash' || toolCall.name === 'bash';
}

function stripAnsi(str: string): string {
  if (typeof str !== 'string') return str;
  return str.replace(ANSI_ESCAPE_PATTERN, '');
}

function BashOutputPreview({ toolCall, status }: { toolCall: ToolCall; status: ToolStatus }) {
  const output = toolCall.result?.output;
  if (!output || typeof output !== 'string') return null;

  const cleaned = stripAnsi(output).trim();
  if (!cleaned) return null;

  const allLines = cleaned.split('\n');
  const isPending = status === 'pending';

  let displayLines: string[];
  let truncatedCount = 0;

  if (isPending) {
    // Show last N lines (streaming feel)
    displayLines = allLines.slice(-BASH_PREVIEW_LINES_PENDING);
  } else {
    // Completed: show first N lines
    if (allLines.length > BASH_PREVIEW_LINES_COMPLETED) {
      displayLines = allLines.slice(0, BASH_PREVIEW_LINES_COMPLETED);
      truncatedCount = allLines.length - BASH_PREVIEW_LINES_COMPLETED;
    } else {
      displayLines = allLines;
    }
  }

  const isError = toolCall.result && !toolCall.result.success;

  return (
    <div className="ml-6 mt-0.5 mb-0.5">
      <pre
        className={`text-xs font-mono leading-relaxed overflow-x-auto scrollbar-hidden whitespace-pre-wrap break-words ${
          isError ? 'text-red-400/80' : 'text-zinc-500'
        }`}
      >
        {displayLines.join('\n')}
      </pre>
      {truncatedCount > 0 && (
        <span className="text-xs text-zinc-600 font-mono">
          ...+{truncatedCount} lines
        </span>
      )}
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
