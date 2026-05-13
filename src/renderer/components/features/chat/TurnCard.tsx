// ============================================================================
// TurnCard - A single conversation turn (user prompt + assistant responses)
// ============================================================================

import React, { useMemo, useState } from 'react';
import type { TraceTurn, TraceNode } from '@shared/contract/trace';
import type { StreamRecoverySnapshot } from '@shared/contract/session';
import type { TurnHookActivity, TurnSkillActivity } from '@shared/contract/turnTimeline';
import { redactBrowserComputerInputPayloadsInValue } from '@shared/utils/browserComputerRedaction';
import {
  Anchor,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  CircleDot,
  FileText,
  LoaderCircle,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Wrench,
  XCircle,
} from 'lucide-react';
import { TraceNodeRenderer } from './TraceNodeRenderer';
import { StreamingIndicator, getRunningToolStartTime } from './StreamingIndicator';
import { TurnDiffSummary } from './MessageBubble/TurnDiffSummary';
import { ToolStepGroup } from './ToolStepGroup';
import {
  groupAdjacentToolCalls,
  formatTurnDuration,
} from '../../../utils/toolStepGrouping';
import {
  buildStreamingUiState,
  hasCancelledRunMarker,
  shouldShowStreamingState,
  type RuntimeSessionStatus,
  type StreamingUiState,
} from '../../../utils/streamingStatePresentation';
import { isReadOnlyArtifactOwnershipItem } from '../../../utils/artifactOwnership';

interface TurnCardProps {
  turn: TraceTurn;
  defaultExpanded?: boolean;
  /** Force expand for search matches */
  forceExpanded?: boolean;
  /** This turn contains the active search match */
  highlightActive?: boolean;
  /** This turn is the current active renderer turn. */
  isActiveTurn?: boolean;
  sessionStatus?: RuntimeSessionStatus | null;
  isSessionProcessing?: boolean;
  streamSnapshot?: StreamRecoverySnapshot | null;
  showSeparator?: boolean;
  onStreamingDisplayUpdate?: (nodeId: string, displayLength: number, isAnimating: boolean) => void;
  onRewindUserPrompt?: (messageId: string, content: string) => void;
}

// 超过该节点数的已完成 turn 默认折叠成 "Worked for Xm Ys"
const FOLD_THRESHOLD = 5;

export const TurnCard: React.FC<TurnCardProps> = ({
  turn,
  defaultExpanded,
  forceExpanded,
  highlightActive,
  isActiveTurn,
  sessionStatus,
  isSessionProcessing,
  streamSnapshot,
  showSeparator = true,
  onStreamingDisplayUpdate,
  onRewindUserPrompt,
}) => {
  const stats = useMemo(() => {
    const duration = turn.endTime ? turn.endTime - turn.startTime : null;
    const time = new Date(turn.startTime).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return { duration, time };
  }, [turn]);

  const isStreaming = turn.status === 'streaming';

  // 把相邻的非 Edit/Write 工具调用聚合成 tool_group
  const displayNodes = useMemo(
    () => groupAdjacentToolCalls(turn.nodes),
    [turn.nodes]
  );

  const foldedView = useMemo(() => {
    const userNode = turn.nodes.find((n) => n.type === 'user') || null;
    const finalTextNode =
      [...turn.nodes]
        .reverse()
        .find(
          (n) =>
            n.type === 'assistant_text' &&
            typeof n.content === 'string' &&
            n.content.trim().length > 0
        ) || null;
    return { userNode, finalTextNode };
  }, [turn.nodes]);

  // 折叠策略：已完成 + 非 streaming + 节点数达阈值 + 确实有最终 assistant 文本
  const canFold =
    turn.status === 'completed' &&
    !isStreaming &&
    turn.nodes.length >= FOLD_THRESHOLD &&
    Boolean(foldedView.finalTextNode);
  const [userExpanded, setUserExpanded] = useState(
    Boolean(defaultExpanded) || !canFold
  );
  const expanded = userExpanded || Boolean(forceExpanded);
  const folded = canFold && !expanded;

  // Codex 式外壳：user 消息 + "Worked for Xm Ys" 折叠/展开按钮 + 最终 AI 结论
  // 中间的 thinking/tool_groups/中间 AI 文本根据 expanded 切换显示
  const lastIndex = displayNodes.length - 1;
  const runningToolStartTime = useMemo(
    () => getRunningToolStartTime(turn.nodes),
    [turn.nodes],
  );
  const streamingState = useMemo(
    () => buildStreamingUiState({
      turn,
      isActiveTurn: Boolean(isActiveTurn),
      sessionStatus,
      isSessionProcessing,
      streamSnapshot,
      runningToolStartTime,
    }),
    [isActiveTurn, isSessionProcessing, runningToolStartTime, sessionStatus, streamSnapshot, turn],
  );
  const hookActivity = useMemo(() => getTurnHookActivity(turn), [turn]);
  const skillActivity = useMemo(() => getTurnSkillActivity(turn), [turn]);

  return (
    <div
      className={`mb-2 transition-colors ${
        highlightActive ? 'bg-amber-500/5' : ''
      }`}
    >
      {showSeparator && (
        <div className="flex items-center gap-2 py-1.5">
          <div className="h-px flex-1 bg-zinc-800"></div>
          <span className="text-[10px] text-zinc-600 shrink-0">
            {stats.time}
            {stats.duration !== null && stats.duration > 0
              ? ` · ${formatTurnDuration(stats.duration)}`
              : ''}
          </span>
          <div className="h-px flex-1 bg-zinc-800"></div>
        </div>
      )}

      {/* Content */}
      <div className="space-y-2 px-4">
        {/* User message always at top */}
        {foldedView?.userNode && (
          <TraceNodeRenderer
            node={foldedView.userNode}
            attachments={foldedView.userNode.attachments}
            onRewindUserPrompt={onRewindUserPrompt}
            rewindDisabled={Boolean(isSessionProcessing)}
          />
        )}

        <TurnRunHeader turn={turn} streamingState={streamingState} />
        {shouldShowStreamingState(streamingState) && (
          <StreamingStateBanner state={streamingState} />
        )}

        {hookActivity && <HookExecutionBanner activity={hookActivity} />}
        {skillActivity && <SkillActivityBanner activity={skillActivity} />}

        {/* "Worked for Xm Ys" toggle — always visible when foldable */}
        {canFold && (
          <button
            onClick={() => setUserExpanded(!expanded)}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors py-0.5"
            aria-expanded={expanded}
            title={expanded ? '折叠本轮' : '展开本轮'}
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3 flex-shrink-0 text-zinc-600" />
            ) : (
              <ChevronRight className="w-3 h-3 flex-shrink-0 text-zinc-600" />
            )}
            <span>
              Worked for{' '}
              {stats.duration ? formatTurnDuration(stats.duration) : '—'}
            </span>
          </button>
        )}

        {/* Middle content (folded: hide; expanded: show all except user) */}
        {!folded && (
          <>
            {displayNodes.map((d, i) => {
              if (d.kind === 'tool_group') {
                return (
                  <ToolStepGroup
                    key={d.key}
                    nodes={d.tools}
                    defaultExpanded={false}
                  />
                );
              }
              const node: TraceNode = d.node;
              // User node rendered above; skip here to avoid duplicate
              if (node.id === foldedView.userNode?.id) {
                return null;
              }
              // Hook/skill activity gets a stable, always-visible banner below the user prompt.
              if (node.turnTimeline?.kind === 'hook_activity' || node.turnTimeline?.kind === 'skill_activity') {
                return null;
              }
              if (node.subtype === 'skill_status') {
                return null;
              }
              // Final text rendered below; skip here to avoid duplicate
              if (canFold && node.id === foldedView?.finalTextNode?.id) {
                return null;
              }
              const isNodeStreaming =
                isStreaming && i === lastIndex && node.type === 'assistant_text';
              const shouldReportDisplayUpdate =
                node.type === 'assistant_text' &&
                Boolean(onStreamingDisplayUpdate) &&
                (isNodeStreaming || (!isStreaming && node.id === foldedView?.finalTextNode?.id));
              return (
                <TraceNodeRenderer
                  key={node.id}
                  node={node}
                  attachments={node.attachments}
                  isStreaming={isNodeStreaming}
                  onStreamingDisplayUpdate={shouldReportDisplayUpdate ? onStreamingDisplayUpdate : undefined}
                  onRewindUserPrompt={onRewindUserPrompt}
                  rewindDisabled={Boolean(isSessionProcessing)}
                />
              );
            })}

            {/* Streaming indicator at bottom of active turn */}
            {isStreaming && turn.nodes.length > 0 && (
              <StreamingIndicator
                startTime={turn.startTime}
                runningToolStartTime={runningToolStartTime}
              />
            )}
          </>
        )}

        {/* Final AI answer (always shown when foldable; non-foldable turns already rendered in map above) */}
        {canFold && foldedView?.finalTextNode && (
          <TraceNodeRenderer
            node={foldedView.finalTextNode}
            attachments={foldedView.finalTextNode.attachments}
            onStreamingDisplayUpdate={onStreamingDisplayUpdate}
          />
        )}

        {/* Turn-level aggregated diff card — always visible */}
        <TurnDiffSummary turn={turn} />
      </div>
    </div>
  );
};

const HOOK_EVENT_LABELS: Record<string, string> = {
  UserPromptSubmit: '用户提示提交',
  SessionStart: '会话开始',
  PreToolUse: '工具前',
  PostToolUse: '工具后',
  PostToolUseFailure: '工具失败',
  PermissionRequest: '权限请求',
  PreCompact: '压缩前',
  PostCompact: '压缩后',
  Stop: '停止',
  StopFailure: '停止失败',
  SessionEnd: '会话结束',
};

function getTurnHookActivity(turn: TraceTurn): TurnHookActivity | null {
  const node = turn.nodes.find((candidate) => (
    candidate.turnTimeline?.kind === 'hook_activity'
    && candidate.turnTimeline.hookActivity
  ));
  return node?.turnTimeline?.hookActivity ?? null;
}

function getTurnSkillActivity(turn: TraceTurn): TurnSkillActivity | null {
  const node = turn.nodes.find((candidate) => (
    candidate.turnTimeline?.kind === 'skill_activity'
    && candidate.turnTimeline.skillActivity
  ));
  return node?.turnTimeline?.skillActivity ?? null;
}

function getHookActivityTone(activity: TurnHookActivity): 'success' | 'warning' | 'error' {
  if (activity.items.some((item) => item.action === 'block')) return 'error';
  if (activity.items.some((item) => (item.errorCount || 0) > 0 || item.modified)) return 'warning';
  return 'success';
}

function getHookStatusText(activity: TurnHookActivity): string {
  const blocked = activity.items.filter((item) => item.action === 'block').length;
  if (blocked > 0) return `${blocked} 次阻止`;
  const errors = activity.items.reduce((sum, item) => sum + (item.errorCount || 0), 0);
  if (errors > 0) return `${errors} 个错误`;
  const modified = activity.items.filter((item) => item.modified).length;
  if (modified > 0) return `${modified} 次改写输入`;
  return '已放行';
}

const HookExecutionBanner: React.FC<{ activity: TurnHookActivity }> = ({ activity }) => {
  const [expanded, setExpanded] = useState(false);
  const totalHooks = activity.items.reduce((sum, item) => sum + item.hookCount, 0);
  const durationMs = activity.items.reduce((sum, item) => sum + item.durationMs, 0);
  const tone = getHookActivityTone(activity);
  const statusText = getHookStatusText(activity);
  const showStatus = tone !== 'success';

  return (
    <div className="py-0.5 text-sm text-zinc-500">
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 rounded-md py-0.5 text-left text-zinc-500 transition-colors hover:text-zinc-300"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={showStatus ? `${statusText} · ${durationMs}ms` : `${durationMs}ms`}
      >
        <Anchor className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate font-medium">执行了 {totalHooks} 个钩子</span>
        {showStatus && (
          <span className={`shrink-0 rounded px-1 py-px text-[11px] ${getHookIssueClass(tone)}`}>
            {statusText}
          </span>
        )}
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        )}
      </button>
      {expanded && (
        <div className="ml-7 mt-1 space-y-1 text-[13px] leading-5 text-zinc-500">
          {activity.items.map((item, index) => {
            const label = HOOK_EVENT_LABELS[item.event] || item.event;
            const title = [
              item.toolName,
              `${item.hookCount} 个 hook`,
              `${item.durationMs}ms`,
              item.message,
            ].filter(Boolean).join(' · ');
            const itemStatus = getHookItemStatusText(item);
            return (
              <div
                key={`${item.event}-${item.timestamp}-${index}`}
                className="flex min-w-0 items-center gap-1.5"
                title={title || undefined}
              >
                <span className="shrink-0">{label}</span>
                <span className="shrink-0">钩子</span>
                {itemStatus && (
                  <span className={`shrink-0 rounded px-1 py-px text-[11px] ${getHookIssueClass(itemStatus.tone)}`}>
                    {itemStatus.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

function getSkillActionLabel(action: TurnSkillActivity['items'][number]['action']): string {
  switch (action) {
    case 'selected':
      return '写入偏好';
    case 'triggered':
      return '已触发';
    case 'written':
      return '已写入';
    default:
      return action;
  }
}

function getSkillActivityTitle(activity: TurnSkillActivity): string {
  const labels = activity.items.map((item) => `${item.label} ${getSkillActionLabel(item.action)}`);
  return labels.join(' · ');
}

const SkillActivityBanner: React.FC<{ activity: TurnSkillActivity }> = ({ activity }) => {
  const [expanded, setExpanded] = useState(true);
  const summary = activity.summary.replace(/^Skill\s*/, '');

  return (
    <div className="py-0.5 text-sm text-zinc-500">
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 rounded-md py-0.5 text-left text-zinc-500 transition-colors hover:text-zinc-300"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={getSkillActivityTitle(activity)}
      >
        <Sparkles className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate font-medium">Skill {summary}</span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        )}
      </button>
      {expanded && (
        <div className="ml-7 mt-1 space-y-1 text-[13px] leading-5 text-zinc-500">
          {activity.items.map((item, index) => (
            <div
              key={`${item.skillId}-${item.action}-${index}`}
              className="flex min-w-0 items-center gap-1.5"
              title={item.detail || undefined}
            >
              <span className="min-w-0 truncate text-zinc-400">{item.label}</span>
              <span className="shrink-0">{getSkillActionLabel(item.action)}</span>
              {item.source && <span className="shrink-0 text-zinc-600">{item.source}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function getHookItemStatusText(
  item: TurnHookActivity['items'][number],
): { label: string; tone: 'warning' | 'error' } | null {
  if (item.action === 'block') return { label: '阻止', tone: 'error' };
  if ((item.errorCount || 0) > 0) return { label: `${item.errorCount} 个错误`, tone: 'warning' };
  if (item.modified) return { label: '改写输入', tone: 'warning' };
  return null;
}

function getLastToolNode(turn: TraceTurn): TraceNode | null {
  for (let index = turn.nodes.length - 1; index >= 0; index--) {
    const node = turn.nodes[index];
    if (node.type === 'tool_call' && node.toolCall) return node;
  }
  return null;
}

function getTurnRunStatus(turn: TraceTurn, streamingState?: StreamingUiState): {
  label: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  icon: React.ReactNode;
} {
  if (streamingState) {
    switch (streamingState.status) {
      case 'cancelling':
        return { label: 'cancelling', tone: 'warning', icon: <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> };
      case 'resumable':
        return { label: 'resumable', tone: 'warning', icon: <RotateCcw className="h-3.5 w-3.5" /> };
      case 'stale':
        return { label: 'stale_stream', tone: 'neutral', icon: <CircleDot className="h-3.5 w-3.5" /> };
      case 'waiting_tool':
        return { label: 'waiting_tool', tone: 'neutral', icon: <Wrench className="h-3.5 w-3.5" /> };
      case 'using_tools':
        return { label: 'using_tools', tone: 'neutral', icon: <Wrench className="h-3.5 w-3.5" /> };
      case 'drafting':
        return { label: 'running', tone: 'info', icon: <CircleDot className="h-3.5 w-3.5" /> };
      case 'blocked':
        return { label: 'blocked', tone: 'error', icon: <ShieldAlert className="h-3.5 w-3.5" /> };
      case 'cancelled':
        return { label: 'cancelled', tone: 'warning', icon: <XCircle className="h-3.5 w-3.5" /> };
      default:
        break;
    }
  }

  if (hasCancelledRunMarker(turn)) {
    return { label: 'cancelled', tone: 'warning', icon: <XCircle className="h-3.5 w-3.5" /> };
  }

  const timelines = turn.nodes
    .map((node) => node.turnTimeline)
    .filter(Boolean);
  const hasError = turn.status === 'error' || timelines.some((timeline) => timeline?.tone === 'error');
  if (hasError) {
    return { label: 'blocked', tone: 'error', icon: <ShieldAlert className="h-3.5 w-3.5" /> };
  }

  const lastTool = getLastToolNode(turn)?.toolCall;
  if (turn.status === 'streaming') {
    if (lastTool && (lastTool._streaming || lastTool.result === undefined)) {
      return { label: 'using_tools', tone: 'neutral', icon: <Wrench className="h-3.5 w-3.5" /> };
    }
    return { label: 'running', tone: 'info', icon: <CircleDot className="h-3.5 w-3.5" /> };
  }

  return { label: 'completed', tone: 'success', icon: <CheckCircle2 className="h-3.5 w-3.5" /> };
}

function getTurnPhase(turn: TraceTurn): string {
  if (hasCancelledRunMarker(turn)) return '本轮已取消';

  const routing = turn.nodes.find((node) => node.turnTimeline?.kind === 'routing_evidence')?.turnTimeline?.routingEvidence;
  if (routing) return routing.summary;

  const scope = turn.nodes.find((node) => node.turnTimeline?.kind === 'capability_scope')?.turnTimeline?.capabilityScope;
  if (scope) {
    if (scope.blocked.length > 0) return `${scope.blocked.length} 个能力未生效`;
    if (scope.invoked.length > 0) return `${scope.invoked.length} 个能力已调用`;
  }

  const lastTool = getLastToolNode(turn)?.toolCall;
  if (lastTool) return lastTool.shortDescription || `工具 ${lastTool.name}`;

  const assistantText = [...turn.nodes].reverse().find((node) => node.type === 'assistant_text' && node.content.trim());
  return assistantText ? '回复已生成' : '等待输出';
}

function getTurnCompletionSignal(turn: TraceTurn): string | null {
  const artifacts = turn.nodes.find((node) => node.turnTimeline?.kind === 'artifact_ownership')?.turnTimeline?.artifactOwnership;
  const deliverableArtifacts = artifacts?.filter((item) => !isReadOnlyArtifactOwnershipItem(item)) ?? [];
  if (deliverableArtifacts.length && turn.status !== 'completed') return `${deliverableArtifacts.length} outputs`;
  const toolCount = turn.nodes.filter((node) => node.type === 'tool_call').length;
  if (toolCount > 0 && turn.status !== 'completed') return `${toolCount} tools`;
  return null;
}

function getToneClass(tone: 'neutral' | 'info' | 'success' | 'warning' | 'error'): string {
  switch (tone) {
    case 'success':
      return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300';
    case 'warning':
      return 'border-amber-500/20 bg-amber-500/10 text-amber-300';
    case 'error':
      return 'border-red-500/20 bg-red-500/10 text-red-300';
    case 'info':
      return 'border-sky-500/20 bg-sky-500/10 text-sky-300';
    default:
      return 'border-white/[0.06] bg-white/[0.02] text-zinc-400';
  }
}

function getHookIssueClass(tone: 'success' | 'warning' | 'error'): string {
  switch (tone) {
    case 'error':
      return 'bg-red-500/10 text-red-300';
    case 'warning':
      return 'bg-amber-500/10 text-amber-300';
    default:
      return 'bg-zinc-800 text-zinc-400';
  }
}

function getStreamingBannerIcon(state: StreamingUiState): React.ReactNode {
  switch (state.status) {
    case 'cancelling':
      return <LoaderCircle className="h-3.5 w-3.5 animate-spin" />;
    case 'resumable':
      return <RotateCcw className="h-3.5 w-3.5" />;
    case 'blocked':
      return <ShieldAlert className="h-3.5 w-3.5" />;
    case 'waiting_tool':
    case 'using_tools':
      return <Wrench className="h-3.5 w-3.5" />;
    case 'stale':
      return <AlertTriangle className="h-3.5 w-3.5" />;
    default:
      return state.shouldAnimate
        ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        : <CircleDot className="h-3.5 w-3.5" />;
  }
}

const StreamingStateBanner: React.FC<{ state: StreamingUiState }> = ({ state }) => (
  <div className={`flex min-h-9 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${getToneClass(state.tone)}`}>
    <div className="shrink-0">{getStreamingBannerIcon(state)}</div>
    <div className="min-w-0 flex-1">
      <div className="truncate font-medium">{state.label}</div>
      {state.detail && (
        <div className="truncate text-[11px] opacity-80">{state.detail}</div>
      )}
    </div>
    {state.showCancelCleanup && (
      <span className="shrink-0 rounded-md bg-black/10 px-1.5 py-0.5 text-[10px] opacity-80">cleanup</span>
    )}
    {state.showResumeHint && (
      <span className="shrink-0 rounded-md bg-black/10 px-1.5 py-0.5 text-[10px] opacity-80">resume</span>
    )}
  </div>
);

const TurnRunHeader: React.FC<{ turn: TraceTurn; streamingState?: StreamingUiState }> = ({ turn, streamingState }) => {
  const status = getTurnRunStatus(turn, streamingState);
  const phase = getTurnPhase(turn);
  const completionSignal = getTurnCompletionSignal(turn);
  const failedTool = turn.nodes.find((node) => node.type === 'tool_call' && node.toolCall?.success === false)?.toolCall;
  const isCompleted = status.tone === 'success';
  const isNormalToolActivity = status.label === 'using_tools' || status.label === 'waiting_tool';

  if (isCompleted || isNormalToolActivity) {
    return null;
  }

  return (
    <div className="flex min-h-7 items-center gap-2 rounded-md border border-white/[0.035] bg-white/[0.012] px-2 py-1 text-[11px]">
      <div className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 ${getToneClass(status.tone)}`}>
        {status.icon}
        <span className="font-medium">{status.label}</span>
      </div>
      <div className="min-w-0 flex-1 truncate text-zinc-400">
        {phase}
      </div>
      {completionSignal && (
        <div className="inline-flex items-center gap-1 rounded-md bg-white/[0.03] px-1.5 py-0.5 text-[11px] text-zinc-500">
          <FileText className="h-3 w-3" />
          <span>{completionSignal}</span>
        </div>
      )}
      {failedTool && (
        <div className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-300" title={formatFailedToolTitle(failedTool)}>
          <XCircle className="h-3 w-3" />
          <span className="max-w-[120px] truncate">{failedTool.name}</span>
        </div>
      )}
    </div>
  );
};

function formatFailedToolTitle(failedTool: NonNullable<TraceNode['toolCall']>): string | undefined {
  if (typeof failedTool.result !== 'string' || !failedTool.result) {
    return undefined;
  }
  const redacted = redactBrowserComputerInputPayloadsInValue(
    failedTool.name,
    (failedTool.args ?? {}) as Record<string, unknown>,
    failedTool.result,
  );
  return typeof redacted === 'string' ? redacted : failedTool.result;
}
