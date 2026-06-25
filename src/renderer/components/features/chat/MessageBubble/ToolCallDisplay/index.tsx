// ============================================================================
// ToolCallDisplay - Claude Code terminal style tool execution display
// StatusIndicator (braille spinner) + ToolName + params + ⎿ result summary
// ============================================================================

import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { ToolCall } from '@shared/contract';
import type { SessionMediaContext } from '@shared/utils/sessionMediaAssets';
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
  getToolPermissionView,
  getToolRecoveryHint,
  type ToolPermissionView,
} from '../../../../../utils/toolExecutionPresentation';
import { computeBashPreviewLines } from './bashOutputPreview';

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
  mediaContext?: SessionMediaContext;
}

export function ToolCallDisplay({
  toolCall,
  index,
  total: _total,
  compact = false,
  mediaContext,
}: ToolCallDisplayProps) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const processingSessionIds = useAppStore(
    (state) => state.processingSessionIds
  );

  // Calculate status
  const status: ToolStatus = useMemo(() => {
    return getToolStatus(toolCall, currentSessionId, processingSessionIds);
  }, [toolCall, currentSessionId, processingSessionIds]);

  // 工具行默认折叠（含 error）：失败回合常常一连十几条同样的报错，全展开会糊成
  // 一面墙（2026-06-25 dogfood：工件修复死锁 trace 不可读）。折叠态仍保留红左边框 +
  // 恢复提示行 + hover 结果摘要，安全信息不丢；用户点击可展开看详情。
  const [expanded, setExpanded] = useState(false);
  // Track if user manually toggled
  const [userToggled, setUserToggled] = useState(false);
  const actionPreview = useMemo(
    () => buildBrowserComputerActionPreview(toolCall),
    [toolCall],
  );
  const workflowStagePreview = useMemo(
    () => buildWorkflowStagePreview(toolCall),
    [toolCall],
  );

  // Auto-collapse on success after 500ms (only if user hasn't manually toggled)
  useEffect(() => {
    if (status === 'success' && expanded && !userToggled) {
      const timer = setTimeout(() => setExpanded(false), 500);
      return () => clearTimeout(timer);
    }
  }, [status, expanded, userToggled]);

  // 仅在 pending 工具产出 live output 时自动展开（流式反馈）；error 不再自动展开，
  // 改为默认折叠，让失败回合的 trace 保持可扫读。
  useEffect(() => {
    if (!toolCall.result && toolCall.liveOutput && !userToggled) {
      setExpanded(true);
    }
  }, [toolCall.result, toolCall.liveOutput, userToggled]);

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

      {workflowStagePreview && (
        <WorkflowStagePreview preview={workflowStagePreview} />
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
          <ToolDetails
            toolCall={toolCall}
            compact={compact}
            mediaContext={{
              ...mediaContext,
              sessionId: mediaContext?.sessionId || currentSessionId || undefined,
            }}
          />
        </div>
      )}
    </div>
  );
}

interface WorkflowStagePreviewData {
  completedStages?: number;
  failedStages?: number;
  stages: Array<{
    name: string;
    role?: string;
    success?: boolean;
    duration?: number;
    toolsUsed: string[];
    toolPolicyMode?: string;
    error?: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function buildWorkflowStagePreview(toolCall: ToolCall): WorkflowStagePreviewData | null {
  if (toolCall.name !== 'workflow_orchestrate') {
    return null;
  }

  const metadata = toolCall.result?.metadata;
  const rawStages = isRecord(metadata) && Array.isArray(metadata.stages)
    ? metadata.stages
    : [];
  const stages = rawStages
    .filter(isRecord)
    .map((stage) => {
      const toolPolicy = isRecord(stage.toolPolicy) ? stage.toolPolicy : undefined;
      return {
        name: asString(stage.name) || 'stage',
        role: asString(stage.role),
        success: asBoolean(stage.success),
        duration: asNumber(stage.duration),
        toolsUsed: asStringArray(stage.toolsUsed),
        toolPolicyMode: asString(toolPolicy?.mode),
        error: asString(stage.error),
      };
    });

  if (stages.length === 0) {
    return null;
  }

  return {
    completedStages: asNumber(metadata?.completedStages),
    failedStages: asNumber(metadata?.failedStages),
    stages,
  };
}

function formatWorkflowDuration(duration: number | undefined): string | null {
  if (duration === undefined) {
    return null;
  }
  if (duration < 1000) {
    return `${duration}ms`;
  }
  return `${(duration / 1000).toFixed(1)}s`;
}

function formatWorkflowPolicy(mode: string | undefined): string | null {
  switch (mode) {
    case 'none':
      return 'no tools';
    case 'readonly':
      return 'readonly';
    case 'allowlist':
      return 'allowlist';
    case 'inherit':
      return null;
    default:
      return mode || null;
  }
}

function formatWorkflowStageName(stage: WorkflowStagePreviewData['stages'][number]): string {
  const name = stage.name.trim();
  const role = stage.role?.trim();
  return name || role || 'stage';
}

function isPolicyAlreadyInName(name: string, policy: string | null): boolean {
  if (!policy) {
    return false;
  }
  return name.toLowerCase().includes(policy.toLowerCase());
}

const WorkflowStagePreview: React.FC<{ preview: WorkflowStagePreviewData }> = ({ preview }) => {
  const completed = preview.completedStages ?? preview.stages.filter((stage) => stage.success !== false).length;
  const failed = preview.failedStages ?? preview.stages.filter((stage) => stage.success === false).length;
  const total = preview.stages.length;
  const showSummary = total > 1;

  return (
    <div className="ml-6 mt-1 mb-0.5 space-y-1 text-xs text-zinc-500">
      {showSummary && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={failed > 0 ? 'text-amber-300' : 'text-zinc-400'}>
            {total} 个子智能体
          </span>
          <span>{completed}/{total} 完成</span>
          {failed > 0 && <span className="text-red-300">{failed} 失败</span>}
        </div>
      )}
      <div className="space-y-0.5">
        {preview.stages.map((stage, index) => {
          const policy = formatWorkflowPolicy(stage.toolPolicyMode);
          const duration = formatWorkflowDuration(stage.duration);
          const displayName = formatWorkflowStageName(stage);
          const role = stage.role?.trim();
          const showPolicy = !isPolicyAlreadyInName(displayName, policy);
          const tools = stage.toolsUsed.length > 0 ? stage.toolsUsed.join(', ') : null;
          return (
            <div
              key={`${stage.name}-${stage.role || 'stage'}`}
              className="space-y-0.5"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className={stage.success === false ? 'text-red-300' : 'text-emerald-300'}>
                  {stage.success === false ? '✗' : '↳'}
                </span>
                <span className="text-zinc-500">{index + 1}.</span>
                <span className="text-zinc-300">
                  {displayName}
                </span>
                {role && role !== displayName && (
                  <span>{role}</span>
                )}
                {policy && showPolicy && (
                  <span className={policy === 'readonly' ? 'text-emerald-300' : 'text-zinc-500'}>
                    {policy}
                  </span>
                )}
                {tools && <span className="truncate">{tools}</span>}
                {duration && <span>{duration}</span>}
              </div>
              {stage.error && (
                <div className="ml-9 break-words text-red-300">
                  {stage.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

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

function getPermissionRiskLabel(permission: ToolPermissionView): string | null {
  switch (permission) {
    case 'write':
      return '会改文件';
    case 'shell':
      return '会执行命令';
    case 'network':
      return '会访问网络';
    case 'desktop':
      return '会操作桌面';
    case 'memory':
      return '会读写记忆';
    default:
      return null;
  }
}

function getVisibleRecoveryHint(toolCall: ToolCall, status: ToolStatus): string | null {
  if (status === 'pending') return null;
  if (status === 'success' && !toolCall.result?.outputPath) return null;
  return getToolRecoveryHint(toolCall, status);
}

const ToolExecutionMetaRow: React.FC<{ toolCall: ToolCall; status: ToolStatus }> = ({ toolCall, status }) => {
  const permission = getToolPermissionView(toolCall.name);
  const permissionLabel = getPermissionRiskLabel(permission);
  const recoveryHint = getVisibleRecoveryHint(toolCall, status);

  if (!permissionLabel && !recoveryHint) {
    return null;
  }

  return (
    <div className="ml-6 mt-0.5 mb-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
      {permissionLabel && (
        <span className={getPermissionToneClass(permission)}>{permissionLabel}</span>
      )}
      {recoveryHint && (
        <span className={status === 'error' ? 'text-red-300' : 'text-zinc-600'}>{recoveryHint}</span>
      )}
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
    </div>
  );
}

// ============================================================================
// Bash Output Preview - inline output when Bash is collapsed
// Pending: last 5 lines (streaming feel)
// Completed: first 20 lines + "...+N lines" if truncated
// ============================================================================

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

  const isPending = status === 'pending';
  const { displayLines } = computeBashPreviewLines(cleaned, isPending);
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
