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
  Brain,
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
import { StreamingIndicator, getRunningToolStartTime, getStreamingWaitingReason } from './StreamingIndicator';
import { TurnDiffSummary } from './MessageBubble/TurnDiffSummary';
import { ToolStepGroup } from './ToolStepGroup';
import {
  groupAdjacentToolCalls,
  formatTurnDuration,
} from '../../../utils/toolStepGrouping';
import { sanitizeThinkingForDisplay } from '../../../utils/toolGrouping';
import {
  buildStreamingUiState,
  hasCancelledRunMarker,
  shouldShowStreamingState,
  type RuntimeSessionStatus,
  type StreamingUiState,
} from '../../../utils/streamingStatePresentation';
import { isReadOnlyArtifactOwnershipItem } from '../../../utils/artifactOwnership';
import { useI18n } from '../../../hooks/useI18n';
import type { Translations } from '../../../i18n';

interface TurnCardProps {
  turn: TraceTurn;
  sessionId?: string;
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
  sessionId,
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
  const { t } = useI18n();
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
  const lastDisplay = displayNodes[lastIndex];
  const lastDisplayNode = lastDisplay && lastDisplay.kind !== 'tool_group' ? lastDisplay.node : null;
  // 末个展示节点是否「正在流式输出可见正文」——若是，正文自带内联光标，状态槽不再重复渲染光标。
  // 必须看 content 是否非空：思考中的合成节点也是 assistant_text 类型但 content 为空，
  // 不能算「正文正在流式」，否则状态槽会误判着落而整个隐去，思考阶段变得完全没有信号。
  const lastNodeIsStreamingText =
    isStreaming &&
    !!lastDisplayNode &&
    lastDisplayNode.type === 'assistant_text' &&
    Boolean(lastDisplayNode.content?.trim());
  // 末个展示节点正在接收思考增量：assistant_text 类型、正文还是空、但已经有思考内容在流入。
  const isThinkingPhase =
    isStreaming &&
    !!lastDisplayNode &&
    lastDisplayNode.type === 'assistant_text' &&
    !lastDisplayNode.content?.trim() &&
    Boolean((lastDisplayNode.thinking || lastDisplayNode.reasoning)?.trim());
  const runningToolStartTime = useMemo(
    () => getRunningToolStartTime(turn.nodes),
    [turn.nodes],
  );
  const streamingState = useMemo(
    () => buildStreamingUiState({
      turn,
      t,
      isActiveTurn: Boolean(isActiveTurn),
      sessionStatus,
      isSessionProcessing,
      streamSnapshot,
      runningToolStartTime,
    }),
    [isActiveTurn, isSessionProcessing, runningToolStartTime, sessionStatus, streamSnapshot, t, turn],
  );
  const hookActivity = useMemo(() => getTurnHookActivity(turn), [turn]);
  const skillActivity = useMemo(() => getTurnSkillActivity(turn), [turn]);
  // @neo tag 触发的 turn：回复以 Neo 参与者身份标识（轻量名字+头像，不是卡片）
  const isNeoTagTurn = useMemo(
    () => turn.nodes.some((node) => node.type === 'user' && Boolean(node.metadata?.neoTag)),
    [turn.nodes],
  );
  const thinkingSegments = useMemo(() => getTurnThinkingSegments(turn), [turn]);

  return (
    <div
      className={`mb-2 transition-colors ${
        highlightActive ? 'bg-amber-500/5' : ''
      }`}
    >
      {showSeparator && (
        <div className="flex items-center gap-2 py-1.5">
          <div className="h-px flex-1 bg-zinc-800"></div>
          <span className="text-[10px] text-zinc-500 shrink-0">
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
            sessionId={sessionId}
            attachments={foldedView.userNode.attachments}
            onRewindUserPrompt={onRewindUserPrompt}
            rewindDisabled={Boolean(isSessionProcessing)}
          />
        )}

        {/* Neo 以参与者身份回复（像 Claude Tag）：轻量身份标识挂在回复头部，会话里不出现工作卡 */}
        {isNeoTagTurn && (
          <div className="flex items-center gap-1.5 pt-0.5" data-testid="neo-turn-identity">
            <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/15">
              <Sparkles className="h-2.5 w-2.5 text-emerald-300" />
            </span>
            <span className="text-[11px] font-medium text-emerald-200/90">Neo</span>
          </div>
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
              用时 {stats.duration ? formatTurnDuration(stats.duration) : '—'}
            </span>
          </button>
        )}

        {/* Middle content (folded: hide; expanded: show all except user) */}
        {!folded && (
          <>
            {/* 一个回合内所有思考段合并成一行「思考」，不再按节点单列（产品拍板）。 */}
            <ThinkingDigestBanner segments={thinkingSegments} />
            {displayNodes.map((d, i) => {
              if (d.kind === 'tool_group') {
                return (
                  <ToolStepGroup
                    key={d.key}
                    nodes={d.tools}
                    sessionId={sessionId}
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
              // 产物/来源节点统一锚到最终答案之后渲染（见下方），避免随流式位置在答案上下漂移。
              if (node.turnTimeline?.kind === 'artifact_ownership') {
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
                  sessionId={sessionId}
                  attachments={node.attachments}
                  isStreaming={isNodeStreaming}
                  onStreamingDisplayUpdate={shouldReportDisplayUpdate ? onStreamingDisplayUpdate : undefined}
                  onRewindUserPrompt={onRewindUserPrompt}
                  rewindDisabled={Boolean(isSessionProcessing)}
                />
              );
            })}

            {/* Streaming indicator at bottom of active turn.
                正文正在流式输出文字时，正文已自带内联光标 → 状态槽隐去光标避免重复。 */}
            {isStreaming && turn.nodes.length > 0 && (
              <StreamingIndicator
                startTime={turn.startTime}
                runningToolStartTime={runningToolStartTime}
                showCaret={!lastNodeIsStreamingText}
                isThinking={isThinkingPhase}
                waitingReason={getStreamingWaitingReason(turn.nodes, streamingState.status)}
              />
            )}
          </>
        )}

        {/* Final AI answer (always shown when foldable; non-foldable turns already rendered in map above) */}
        {canFold && foldedView?.finalTextNode && (
          <TraceNodeRenderer
            node={foldedView.finalTextNode}
            sessionId={sessionId}
            attachments={foldedView.finalTextNode.attachments}
            onStreamingDisplayUpdate={onStreamingDisplayUpdate}
          />
        )}

        {/* 产物/来源固定锚点：始终渲染在最终答案之后，位置稳定（与正文内 Sources 一致），
            不再随工具调用在流中的位置而在答案上方/下方漂移。 */}
        {!folded && (() => {
          const artifactNode = turn.nodes.find(
            (node) => node.turnTimeline?.kind === 'artifact_ownership',
          );
          return artifactNode ? (
            <TraceNodeRenderer key={artifactNode.id} node={artifactNode} sessionId={sessionId} />
          ) : null;
        })()}

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
  // 默认展开：非程序员用户不需要多点一次才能看到钩子做了什么。
  const [expanded, setExpanded] = useState(true);
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
            // 钩子实际注入/触发的内容类型：优先用钩子自己的输出消息（最贴近"注入了什么"），
            // 没有消息时退回工具名或 matcher，作为能推出的最有用信息。
            // 来源(全局/项目)、可干预/仅观察对非程序员是噪音，连 hover tooltip 也不放。
            const injectedContentLabel = item.message || item.toolName || item.matcher || undefined;
            const title = [
              item.matcher ? `matcher: ${item.matcher}` : undefined,
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
                {injectedContentLabel && (
                  <span className="min-w-0 truncate text-zinc-600">{injectedContentLabel}</span>
                )}
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
  // 默认折叠：摘要行已说明 skill 活动，展开才看逐条明细，与 Hook 横幅一致。
  const [expanded, setExpanded] = useState(false);
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface TurnThinkingSegment {
  id: string;
  text: string;
}

/**
 * 一个回合内所有思考段合并展示的数据源：按时序收集每个 assistant_text 节点上
 * 的 thinking/reasoning，过滤掉清洗后为空的。产品拍板：主流视野里一回合最多
 * 一行「思考」，不再按节点单列——这里只负责收集，展示在 ThinkingDigestBanner。
 */
function getTurnThinkingSegments(turn: TraceTurn): TurnThinkingSegment[] {
  const segments: TurnThinkingSegment[] = [];
  for (const node of turn.nodes) {
    if (node.type !== 'assistant_text') continue;
    const text = sanitizeThinkingForDisplay(node.thinking || node.reasoning)?.trim();
    if (text) segments.push({ id: node.id, text });
  }
  return segments;
}

const ThinkingDigestBanner: React.FC<{ segments: TurnThinkingSegment[] }> = ({ segments }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (segments.length === 0) return null;

  const digestLabel = t.chat.thinkingDigest
    + (segments.length > 1 ? t.chat.thinkingSegments.replace('{count}', String(segments.length)) : '');

  return (
    <div className="py-0.5 text-sm text-zinc-500">
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 rounded-md py-0.5 text-left text-zinc-500 transition-colors hover:text-zinc-300"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={expanded ? t.chat.collapseThinking : t.chat.expandThinking}
      >
        <Brain className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate font-medium">{digestLabel}</span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        )}
      </button>
      {expanded && (
        <div className="ml-7 mt-1 space-y-2 text-[13px] leading-5 text-zinc-500">
          {segments.map((segment, index) => (
            <p key={segment.id} className="whitespace-pre-line font-mono">
              {segments.length > 1 ? `${index + 1}. ` : ''}
              {segment.text}
            </p>
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

// status key（稳定枚举字符串，供 shouldHideTurnRunHeader/测试等逻辑判断用）
// 与 label（走 i18n 的人话显示文案）分开——逻辑别读人话文案。
function getTurnRunStatus(turn: TraceTurn, t: Translations, streamingState?: StreamingUiState): {
  key: string;
  label: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  icon: React.ReactNode;
} {
  if (streamingState) {
    switch (streamingState.status) {
      case 'cancelling':
        return { key: 'cancelling', label: streamingState.label, tone: 'warning', icon: <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> };
      case 'resumable':
        return { key: 'resumable', label: streamingState.label, tone: 'warning', icon: <RotateCcw className="h-3.5 w-3.5" /> };
      case 'stale':
        return { key: 'stale_stream', label: streamingState.label, tone: 'neutral', icon: <CircleDot className="h-3.5 w-3.5" /> };
      case 'waiting_tool':
        return { key: 'waiting_tool', label: streamingState.label, tone: 'neutral', icon: <Wrench className="h-3.5 w-3.5" /> };
      case 'using_tools':
        return { key: 'using_tools', label: streamingState.label, tone: 'neutral', icon: <Wrench className="h-3.5 w-3.5" /> };
      case 'drafting':
        return { key: 'running', label: streamingState.label, tone: 'info', icon: <CircleDot className="h-3.5 w-3.5" /> };
      case 'blocked':
        return { key: 'blocked', label: streamingState.label, tone: 'error', icon: <ShieldAlert className="h-3.5 w-3.5" /> };
      case 'cancelled':
        return { key: 'cancelled', label: streamingState.label, tone: 'warning', icon: <XCircle className="h-3.5 w-3.5" /> };
      default:
        break;
    }
  }

  if (hasCancelledRunMarker(turn)) {
    return { key: 'cancelled', label: t.turnRun.status.cancelled, tone: 'warning', icon: <XCircle className="h-3.5 w-3.5" /> };
  }

  const timelines = turn.nodes
    .map((node) => node.turnTimeline)
    .filter(Boolean);
  const hasError = turn.status === 'error' || timelines.some((timeline) => timeline?.tone === 'error');
  if (hasError) {
    return { key: 'blocked', label: t.turnRun.status.blocked, tone: 'error', icon: <ShieldAlert className="h-3.5 w-3.5" /> };
  }

  const lastTool = getLastToolNode(turn)?.toolCall;
  if (turn.status === 'streaming') {
    if (lastTool && (lastTool._streaming || lastTool.result === undefined)) {
      return { key: 'using_tools', label: t.turnRun.status.usingTools, tone: 'neutral', icon: <Wrench className="h-3.5 w-3.5" /> };
    }
    return { key: 'running', label: t.turnRun.status.running, tone: 'info', icon: <CircleDot className="h-3.5 w-3.5" /> };
  }

  return { key: 'completed', label: t.turnRun.status.completed, tone: 'success', icon: <CheckCircle2 className="h-3.5 w-3.5" /> };
}

function getTurnPhase(turn: TraceTurn): string | null {
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

  if (turn.status === 'streaming') return null;

  const assistantText = [...turn.nodes].reverse().find((node) => node.type === 'assistant_text' && node.content.trim());
  return assistantText ? '回复已生成' : '等待输出';
}

function getTurnCompletionSignal(turn: TraceTurn, t: Translations): string | null {
  const artifacts = turn.nodes.find((node) => node.turnTimeline?.kind === 'artifact_ownership')?.turnTimeline?.artifactOwnership;
  const deliverableArtifacts = artifacts?.filter((item) => !isReadOnlyArtifactOwnershipItem(item)) ?? [];
  if (deliverableArtifacts.length && turn.status !== 'completed') {
    return t.turnRun.outputsSignal.replace('{count}', String(deliverableArtifacts.length));
  }
  const toolCount = turn.nodes.filter((node) => node.type === 'tool_call').length;
  if (toolCount > 0 && turn.status !== 'completed') {
    return t.turnRun.toolsSignal.replace('{count}', String(toolCount));
  }
  return null;
}

function getToneClass(tone: 'neutral' | 'info' | 'success' | 'warning' | 'error'): string {
  switch (tone) {
    case 'success':
      return 'border-emerald-500/20 bg-emerald-500/10 text-status-success';
    case 'warning':
      return 'border-amber-500/20 bg-amber-500/10 text-status-warning';
    case 'error':
      return 'border-red-500/20 bg-red-500/10 text-status-error';
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

const StreamingStateBanner: React.FC<{ state: StreamingUiState }> = ({ state }) => {
  const { t } = useI18n();
  return (
    <div className={`flex min-h-9 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${getToneClass(state.tone)}`}>
      <div className="shrink-0">{getStreamingBannerIcon(state)}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{state.label}</div>
        {state.detail && (
          <div className="truncate text-[11px] opacity-80">{state.detail}</div>
        )}
      </div>
      {state.showCancelCleanup && (
        <span className="shrink-0 text-[10px] opacity-60">{t.turnRun.cleanupBadge}</span>
      )}
      {state.showResumeHint && (
        <span className="shrink-0 text-[10px] opacity-60">{t.turnRun.resumeBadge}</span>
      )}
    </div>
  );
};

// 顶部 run 横幅可见性：完成态 + 正常流式进度（running / using_tools / waiting_tool）
// 统一隐藏。这些状态在流式期间随工具边界来回切换，会让蓝色 running 横幅 mount/unmount
// 「跳上跳下」。正常 live 进度由底部 StreamingIndicator + 工具组内联指示承担；顶部横幅
// 只在异常/终态（blocked/cancelled/resumable/stale）显示稳定状态。
// 吃 status key（稳定枚举），不吃 label（人话显示文案）——语言切换不能影响这条逻辑判断。
export function shouldHideTurnRunHeader(statusKey: string, statusTone: string): boolean {
  return statusTone === 'success'
    || statusKey === 'running'
    || statusKey === 'using_tools'
    || statusKey === 'waiting_tool';
}

const TurnRunHeader: React.FC<{ turn: TraceTurn; streamingState?: StreamingUiState }> = ({ turn, streamingState }) => {
  const { t } = useI18n();
  const status = getTurnRunStatus(turn, t, streamingState);
  const phase = getTurnPhase(turn);
  const completionSignal = getTurnCompletionSignal(turn, t);
  const failedTool = turn.nodes.find((node) => node.type === 'tool_call' && node.toolCall?.success === false)?.toolCall;
  const hasPhase = Boolean(phase?.trim());

  if (shouldHideTurnRunHeader(status.key, status.tone)) {
    return null;
  }

  return (
    <div className="flex min-h-7 items-center gap-2 rounded-md border border-border-faint bg-surface-faint px-2 py-1 text-[11px]">
      <div className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 ${getToneClass(status.tone)}`}>
        {status.icon}
        <span className="font-medium">{status.label}</span>
      </div>
      {hasPhase && (
        <div className="min-w-0 flex-1 truncate text-zinc-400">
          {phase}
        </div>
      )}
      {!hasPhase && <div className="flex-1" />}
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
