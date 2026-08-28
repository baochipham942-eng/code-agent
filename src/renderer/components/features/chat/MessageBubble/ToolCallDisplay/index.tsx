// ============================================================================
// ToolCallDisplay - Claude Code terminal style tool execution display
// StatusIndicator (braille spinner) + ToolName + params + ⎿ result summary
// ============================================================================

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { StreamInterruptionReason, ToolCall } from '@shared/contract';
import type { SessionMediaContext } from '@shared/utils/sessionMediaAssets';
import { useAppStore } from '../../../../../stores/appStore';
import { isToolCallAwaitingApproval } from '../../../../../utils/sessionNeedsInput';
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
  humanizeToolError,
  isEscalatedToolError,
} from '../../../../../utils/toolExecutionPresentation';
import type { Translations } from '../../../../../i18n';
import { computeBashPreviewLines } from './bashOutputPreview';
import {
  buildAskUserQuestionRecord,
  type AskUserQuestionRecord,
} from '../../../../../utils/askUserQuestionRecord';
import { useI18n } from '../../../../../hooks/useI18n';
import { useBackgroundTaskStore } from '../../../../../stores/backgroundTaskStore';
import { useAgentTreeSnapshot } from '../../../../../hooks/useAgentTreeSnapshot';
import { isDelegationTool } from '../../../../../utils/agentActivity';
import { DelegationHeader, DelegationReceipt } from './DelegationReceipt';
import {
  deriveDelegationPresentation,
  resolveAgentActivityTarget,
} from './delegationPresentation';
import { humanizeToolStep } from '../../../../../utils/humanizeToolStep';
import { getHumanToolLabel } from '../../../../../utils/toolHumanLabel';

// ============================================================================
// StatusIndicator - Braille spinner for pending, symbols for final states
// ============================================================================

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAME_INTERVAL_MS = 240;

// quietError: 探索性失败（agent 试错，非用户需介入的错误）——用中性、非加粗样式，
// 与成功行视觉权重接近，别让每一次试错都喊得像出了大事。
function StatusIndicator({ status, quietError }: { status: ToolStatus; quietError?: boolean }) {
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
        <span
          className={`w-4 flex-shrink-0 text-center ${quietError ? 'text-[var(--cc-muted)]' : `font-bold ${statusColor.dot}`}`}
        >
          {quietError ? '●' : '✗'}
        </span>
      );
    case 'interrupted':
      return (
        <span className={`w-4 flex-shrink-0 text-center ${statusColor.dot}`}>
          ⊘
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
  /** recovery snapshot 的工具从未执行，后续新 turn 在跑时也必须稳定保持 interrupted。 */
  statusOverride?: ToolStatus;
  interruptionReason?: StreamInterruptionReason;
  receipt?: ToolReceiptPresentation;
}

export interface ToolReceiptPresentation {
  status: 'succeeded' | 'failed';
  detail?: string;
  sourceTool: string;
  connector?: string;
  createdAt: number;
}

export function ToolCallDisplay({
  toolCall,
  index,
  total: _total,
  compact = false,
  mediaContext,
  statusOverride,
  interruptionReason,
  receipt,
}: ToolCallDisplayProps) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const processingSessionIds = useAppStore((state) => state.processingSessionIds);
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore((state) => state.pendingPermissionSessionId);
  const queuedPermissionRequests = useAppStore((state) => state.queuedPermissionRequests);
  const backgroundTasks = useBackgroundTaskStore((state) => state.tasks);
  const sessionId = mediaContext?.sessionId || currentSessionId;
  const awaitingApproval = toolCall.result === undefined
    && isToolCallAwaitingApproval(toolCall.id, sessionId, {
      pendingPermissionRequest,
      pendingPermissionSessionId,
      queuedPermissionRequests,
    });
  const delegationTool = isDelegationTool(toolCall.name);
  const { snapshot: agentTree } = useAgentTreeSnapshot(
    sessionId ?? null,
    delegationTool && toolCall.name === 'spawn_agent',
  );
  const delegationPresentation = useMemo(() => {
    if (!delegationTool) return null;
    const presentation = deriveDelegationPresentation(
      toolCall,
      backgroundTasks,
      agentTree?.nodes ?? [],
    );
    if (!presentation) return null;
    return {
      ...presentation,
      lastToolStep: resolveAgentActivityTarget(
        presentation.lastToolStep,
        agentTree?.nodes ?? [],
      ),
    };
  }, [agentTree?.nodes, backgroundTasks, delegationTool, toolCall]);

  // Calculate status
  const derivedStatus: ToolStatus = useMemo(() => {
    if (statusOverride) return statusOverride;
    if (awaitingApproval) return 'pending';
    if (receipt) return receipt.status === 'failed' ? 'error' : 'success';
    if (delegationPresentation?.state === 'working') return 'pending';
    if (delegationPresentation?.state === 'completed') return 'success';
    if (delegationPresentation?.state === 'failed') return 'error';
    return getToolStatus(toolCall, currentSessionId, processingSessionIds);
  }, [awaitingApproval, delegationPresentation?.state, toolCall, currentSessionId, processingSessionIds, receipt, statusOverride]);
  // 收口时内存消息会先终态，随后持久化列表回填；回填窗口里同一 call 可能短暂缺 result。
  // 一旦同一 toolCall 到达成功/失败，renderer 不再把它降回 pending/interrupted。
  const terminalStatusRef = useRef<{ toolCallId: string; status: ToolStatus | null }>({
    toolCallId: toolCall.id,
    status: null,
  });
  if (terminalStatusRef.current.toolCallId !== toolCall.id) {
    terminalStatusRef.current = { toolCallId: toolCall.id, status: null };
  }
  if (receipt && terminalStatusRef.current.status === null && (derivedStatus === 'success' || derivedStatus === 'error')) {
    terminalStatusRef.current.status = derivedStatus;
  }
  const status = terminalStatusRef.current.status ?? derivedStatus;

  // 探索性失败（工具未安装、非零退出码、超时等未分类错误）是 agent 试错的正常一部分，
  // 不是需要用户关注的错误——安静展示，跟成功行视觉权重接近。真正需要用户介入的错误
  // （鉴权失效/额度耗尽/限流）保留醒目红色样式。
  const quietError = status === 'error' && !delegationPresentation && !isEscalatedToolError(toolCall);

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
  // G2：AskUserQuestion 的问答记录（问题 + 所选答案），折叠态也常驻——
  // 打断式选项卡回答后，这就是消息流里可回看的那条记录。
  const askUserRecord = useMemo(
    () => buildAskUserQuestionRecord(toolCall),
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

  const toggleExpanded = () => {
    setExpanded((value) => !value);
    setUserToggled(true);
  };

  return (
    <div
      className={`group font-mono text-sm ${
        status === 'error'
          ? `border-l-2 pl-2 ${quietError ? 'border-[var(--cc-muted)]/40' : 'border-[var(--cc-error)]'}`
          : ''
      }`}
      data-testid={status === 'interrupted' ? 'interrupt-timeline-step' : undefined}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Main row: [StatusIndicator] [ToolName bold] [params muted] [inline file badge for Write] */}
      <div
        data-testid={`tool-call-row-${toolCall.name}`}
        role={status === 'interrupted' ? undefined : 'button'}
        tabIndex={status === 'interrupted' ? -1 : 0}
        aria-expanded={status === 'interrupted' ? undefined : expanded}
        className={`group/row flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors ${
          status === 'interrupted'
            ? 'cursor-default text-xs text-zinc-500'
            : 'cursor-pointer hover:bg-zinc-800'
        }`}
        onClick={status === 'interrupted' ? undefined : toggleExpanded}
        onKeyDown={(event) => {
          if (status === 'interrupted') return;
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleExpanded();
          }
        }}
      >
        <StatusIndicator status={status} quietError={quietError} />
        {delegationPresentation
          ? <DelegationHeader presentation={delegationPresentation} />
          : <ToolHeader
              toolCall={toolCall}
              status={status}
              awaitingApproval={awaitingApproval}
              interruptionReason={interruptionReason}
              showDetailName={expanded}
              hideStatusLabel={Boolean(receipt)}
            />}
        {receipt && (
          <ToolReceiptMeta receipt={receipt} />
        )}
        {!receipt && toolCall.result && !delegationPresentation && !expanded && !isBashTool(toolCall) && (
          <span className="min-w-0 max-w-[220px] shrink truncate text-xs text-zinc-500">
            <ResultSummary toolCall={toolCall} inline />
          </span>
        )}
      </div>

      {delegationPresentation && <DelegationReceipt presentation={delegationPresentation} />}

      {!delegationPresentation && actionPreview && (
        <BrowserComputerActionPreviewLine preview={actionPreview} />
      )}

      {workflowStagePreview && (
        <WorkflowStagePreview preview={workflowStagePreview} />
      )}

      {askUserRecord && (
        <AskUserQuestionRecordBlock record={askUserRecord} />
      )}

      {/* Bash inline output - when collapsed, show command output preview */}
      {!expanded && isBashTool(toolCall) && toolCall.result && (
        <BashOutputPreview toolCall={toolCall} status={status} quietError={quietError} />
      )}

      {/* Expanded details - indented under tool name */}
      {expanded && receipt && (
        <ReceiptDetail receipt={receipt} toolCall={toolCall} />
      )}
      {expanded && !receipt && (
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

function ToolReceiptMeta({ receipt }: { receipt: ToolReceiptPresentation }) {
  const { language, t } = useI18n();
  const sourceLabel = getHumanToolLabel({
    connector: receipt.connector,
    toolName: receipt.sourceTool,
    labels: t.receiptPresentation.humanToolLabels,
  });
  const time = new Date(receipt.createdAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <span
      className="min-w-0 max-w-[220px] shrink truncate text-right text-[10px] text-zinc-500"
      data-testid="tool-step-receipt-meta"
      title={`${receipt.status === 'failed' ? t.receiptPresentation.failed : t.receiptPresentation.succeeded} · ${sourceLabel} · ${time}`}
    >
      {receipt.status === 'failed' ? t.receiptPresentation.failed : t.receiptPresentation.succeeded} · {sourceLabel} · {time}
    </span>
  );
}

function ReceiptDetail({ receipt, toolCall }: { receipt: ToolReceiptPresentation; toolCall: ToolCall }) {
  const raw = receipt.detail || toolCall.result?.output || toolCall.result?.error;
  if (!raw) return null;
  return (
    <pre
      className={`ml-6 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border px-2.5 py-2 text-[11px] leading-relaxed animate-fadeIn ${
        receipt.status === 'failed'
          ? 'border-red-500/20 bg-red-500/[0.05] text-badge-danger/80'
          : 'border-white/[0.06] bg-black/15 text-zinc-400'
      }`}
      data-testid="tool-step-receipt-detail"
    >
      {raw}
    </pre>
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

function formatWorkflowPolicy(
  mode: string | undefined,
  copy: Translations['rendererHumanPipe']['workflowPreview'],
): string | null {
  switch (mode) {
    case 'none':
      return copy.policies.none;
    case 'readonly':
      return copy.policies.readonly;
    case 'allowlist':
      return copy.policies.allowlist;
    case 'inherit':
      return null;
    default:
      return null;
  }
}

function humanizeWorkflowTool(
  toolName: string,
  t: Translations,
  copy: Translations['rendererHumanPipe']['workflowPreview'],
): string {
  const label = humanizeToolStep(toolName, undefined, t);
  return label.includes(toolName) ? copy.genericTool : label;
}

const WorkflowStageError: React.FC<{ error: string }> = ({ error }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const copy = t.rendererHumanPipe.workflowPreview;
  const humanError = humanizeToolError(error, undefined, t);
  return (
    <div className="ml-9 break-words text-badge-danger">
      <div>{humanError?.summary ?? copy.errorSummary}</div>
      <div className="text-[10px] text-badge-danger/70">{humanError?.detail ?? copy.errorDetail}</div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="mt-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
      >
        {expanded ? t.systemError.hideDetails : copy.viewRawError}
      </button>
      {expanded && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[10px] text-zinc-500">
          {error}
        </pre>
      )}
    </div>
  );
};

const WorkflowStagePreview: React.FC<{ preview: WorkflowStagePreviewData }> = ({ preview }) => {
  const { t } = useI18n();
  const copy = t.rendererHumanPipe.workflowPreview;
  const completed = preview.completedStages ?? preview.stages.filter((stage) => stage.success !== false).length;
  const failed = preview.failedStages ?? preview.stages.filter((stage) => stage.success === false).length;
  const total = preview.stages.length;
  const showSummary = total > 1;

  return (
    <div className="ml-6 mt-1 mb-0.5 space-y-1 text-xs text-zinc-500">
      {showSummary && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={failed > 0 ? 'text-badge-warning' : 'text-zinc-400'}>
            {copy.agents.replace('{count}', String(total))}
          </span>
          <span>{copy.completed.replace('{completed}', String(completed)).replace('{total}', String(total))}</span>
          {failed > 0 && (
            <span className="text-badge-danger">{copy.failed.replace('{count}', String(failed))}</span>
          )}
        </div>
      )}
      <div className="space-y-0.5">
        {preview.stages.map((stage, index) => {
          const policy = formatWorkflowPolicy(stage.toolPolicyMode, copy);
          const duration = formatWorkflowDuration(stage.duration);
          const tools = stage.toolsUsed.length > 0
            ? [...new Set(stage.toolsUsed.map((toolName) => humanizeWorkflowTool(toolName, t, copy)))].join('、')
            : null;
          return (
            <div
              key={`${stage.name}-${stage.role || 'stage'}`}
              className="space-y-0.5"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className={stage.success === false ? 'text-badge-danger' : 'text-badge-success'}>
                  {stage.success === false ? '✗' : '↳'}
                </span>
                <span className="text-zinc-500">{index + 1}.</span>
                <span className="text-zinc-300">{copy.step.replace('{count}', String(index + 1))}</span>
                {policy && (
                  <span className={stage.toolPolicyMode === 'readonly' ? 'text-badge-success' : 'text-zinc-500'}>
                    {policy}
                  </span>
                )}
                {tools && <span className="truncate">{copy.usedTools.replace('{tools}', tools)}</span>}
                {duration && <span>{duration}</span>}
              </div>
              {stage.error && <WorkflowStageError error={stage.error} />}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// G2：AskUserQuestion 问答记录块默认收成一行，展开后复用原有逐题 Q&A 结构。
const AskUserQuestionRecordBlock: React.FC<{ record: AskUserQuestionRecord }> = ({ record }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const declinedLine = `${t.userQuestion.declinedRecord}${record.declineReason ? `：${record.declineReason}` : ''}`;
  const summary = record.kind === 'answered'
    ? t.userQuestion.answeredSummary(record.items.length)
    : declinedLine;
  return (
    <div className="ml-6 mt-1 mb-0.5 text-xs" data-testid="ask-user-question-record">
      <button /* ds-allow:button: 整行摘要是展开/收起开关（图标+动态摘要复合内容） */
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex max-w-full items-center gap-1.5 rounded border border-zinc-800 bg-white/[0.03] px-2 py-1 text-left text-zinc-400 hover:border-zinc-700 hover:text-zinc-300"
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
          : <ChevronRight className="h-3 w-3 shrink-0 text-zinc-500" />}
        <span className="truncate">
          <span className={record.kind === 'answered' ? 'text-badge-info' : ''}>{summary}</span>
          {' · '}{expanded ? t.userQuestion.collapseRecord : t.userQuestion.expandRecord}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-1" data-testid="ask-user-question-record-details">
          {record.items.map((item, index) => (
            <div key={item.header} className="space-y-0.5">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-zinc-500">
                  {item.header}
                </span>
                <span className="min-w-0 break-words text-zinc-400">{item.question}</span>
              </div>
              <div className="ml-2 break-words whitespace-pre-wrap text-zinc-300">
                {record.kind === 'declined' ? (index === 0 ? declinedLine : null) : item.answer}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function getActionPreviewRiskClass(risk: BrowserComputerActionPreview['risk']): string {
  switch (risk) {
    case 'read':
      return 'text-badge-success';
    case 'browser_action':
      return 'text-badge-info';
    case 'desktop_input':
      return 'text-badge-warning';
    default:
      return 'text-zinc-400';
  }
}

function BrowserComputerActionPreviewLine({ preview }: { preview: BrowserComputerActionPreview }) {
  const { t } = useI18n();
  return (
    <div className="ml-6 mt-0.5 mb-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
      <span className="text-zinc-600">{t.toolDisplay.action}</span>
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

function BashOutputPreview({ toolCall, status, quietError }: { toolCall: ToolCall; status: ToolStatus; quietError?: boolean }) {
  const output = toolCall.result?.output;
  if (!output || typeof output !== 'string') return null;

  const cleaned = stripAnsi(output).trim();
  if (!cleaned) return null;

  const isPending = status === 'pending';
  const { displayLines } = computeBashPreviewLines(cleaned, isPending);
  const isError = toolCall.result && !toolCall.result.success && !quietError;

  return (
    <div className="ml-6 mt-0.5 mb-0.5">
      <pre
        className={`text-xs font-mono leading-relaxed overflow-x-auto scrollbar-hidden whitespace-pre-wrap break-words ${
          isError ? 'text-badge-danger/80' : 'text-zinc-500'
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
export { getToolIcon, formatParams, getToolDisplayName } from './utils';
export { summarizeTool } from './summarizers';
