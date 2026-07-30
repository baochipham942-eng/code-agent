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
  AudioLines,
  Brain,
  ChevronRight,
  ChevronDown,
  Check,
  CheckCircle2,
  CircleDot,
  Copy,
  FileText,
  GitFork,
  LoaderCircle,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Button } from '../../primitives';
import { UI } from '@shared/constants';
import { TraceNodeRenderer } from './TraceNodeRenderer';
import { StreamingIndicator, getRunningToolStartTime, getStreamingWaitingReason } from './StreamingIndicator';
import { TurnDiffSummary } from './MessageBubble/TurnDiffSummary';
import { isFileChangeCardOwnedNode } from '../../../utils/turnDiffSummary';
import { TurnFeedback } from './TurnFeedback';
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
import { useMessageActionStore } from '../../../stores/messageActionStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useVoiceCallStore } from '../../../stores/voiceCallStore';

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
  /** 会话最后一轮：操作行（复制/赞/踩/分叉）只在这轮常驻，历史轮 hover 才显示 */
  isLastTurn?: boolean;
  sessionStatus?: RuntimeSessionStatus | null;
  isSessionProcessing?: boolean;
  streamSnapshot?: StreamRecoverySnapshot | null;
  showSeparator?: boolean;
  onStreamingDisplayUpdate?: (nodeId: string, displayLength: number, isAnimating: boolean) => void;
  onRewindUserPrompt?: (messageId: string, content: string) => void;
  /** 渲染在该 turn 用户消息上方（目前用于分叉子会话首段的来源提示） */
  beforeUserMessage?: React.ReactNode;
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
  isLastTurn,
  sessionStatus,
  isSessionProcessing,
  streamSnapshot,
  showSeparator = true,
  onStreamingDisplayUpdate,
  onRewindUserPrompt,
  beforeUserMessage,
}) => {
  const { t } = useI18n();
  const createForkFromReply = useMessageActionStore((state) => state.createForkFromReply);
  const sessionIsRunning = useSessionStore((state) => (
    sessionId ? Boolean(state.runningSessionIds?.has(sessionId)) : false
  ));
  const voiceCallInFlight = useVoiceCallStore((state) => (
    state.phase === 'live' || state.phase === 'connecting'
  ));
  const [isForking, setIsForking] = useState(false);
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

  // 语音派活任务卡（W6-5）：一通电话里派出去的活，整轮折叠成一张任务卡——
  // 卡头说清「这件活是什么 + 谁做的 + 什么结果」，过程（工具调用、中间文本）默认折叠，
  // 结论留在卡外。判据：轮内首个带 metadata.voiceDispatch 的节点（投影层保证它是轮首）。
  const voiceDispatch = useMemo(() => {
    for (const node of turn.nodes) {
      const dispatch = node.metadata?.voiceDispatch;
      if (dispatch) return dispatch;
    }
    return null;
  }, [turn.nodes]);
  const isVoiceTurn = Boolean(voiceDispatch);

  const foldedView = useMemo(() => {
    const userNode = turn.nodes.find((n) => n.type === 'user') || null;
    // 「结论」= 这一轮最后一条有正文的 assistant 文本。语音任务卡里要把派活指令
    // 节点自己排除掉——它也是 assistant_text 且有正文（改写后的指令），不排除的话
    // 一个什么都没产出的轮会把指令原文顶到卡外当结论。
    const finalTextNode =
      [...turn.nodes]
        .reverse()
        .find(
          (n) =>
            n.type === 'assistant_text' &&
            typeof n.content === 'string' &&
            n.content.trim().length > 0 &&
            !(isVoiceTurn && n.metadata?.voiceDispatch)
        ) || null;
    return { userNode, finalTextNode };
  }, [turn.nodes, isVoiceTurn]);

  // 折叠策略：已完成 + 非 streaming + 节点数达阈值 + 确实有最终 assistant 文本。
  // 语音任务卡不套这条阈值——电话里派出去的活不管几步都折成卡（用户在打电话，不看屏幕），
  // 流式期间也折：live 信号由卡身底部的呼吸态指示承担，过程默认不铺开。
  const canFold = isVoiceTurn
    ? turn.nodes.length > 0
    : turn.status === 'completed' &&
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
  // 投影层已经挑好了这一轮该被评价的那个节点（markFeedbackEligibleNodes），
  // 这里只借它的 messageId 当锚点，判定逻辑不搬也不复制一份。
  const feedbackAnchor = useMemo(() => {
    if (isStreaming) return null;
    const node = turn.nodes.find((item) => item.feedbackEligible === true);
    const content = node?.content?.trim();
    if (!node || !content) return null;
    const messageId = node.messageId
      || (node.id.endsWith('-text') ? node.id.slice(0, -5) : node.id);
    return { messageId, content };
  }, [isStreaming, turn.nodes]);
  const forkAnchor = useMemo(() => {
    if (isStreaming) return null;
    // X5.5-D3：fork 锚点与 feedback 锚点用同一份 eligible 判定（投影层
    // markFeedbackEligibleNodes，feedbackEligible 只在轮 completed 时落）。
    // 此前 fork 自己找「最后一条有正文的 assistant_text」——轮被切成 completed
    // 且轮尾恰挂 tool_call 时 feedback 锚隐、fork 锚显，动作条只剩一个 fork 图标。
    const node = turn.nodes.find((item) => item.feedbackEligible === true);
    if (!node) return null;
    const messageId = node.messageId
      || (node.id.endsWith('-text') ? node.id.slice(0, -5) : node.id);
    return { messageId };
  }, [isStreaming, turn.nodes]);

  const hasVoiceFailureEvidence = useMemo(
    () => isVoiceTurn && (
      turn.status === 'error'
      || turn.nodes.some((node) => (
        (node.type === 'system' && node.subtype === 'error' && node.metadata?.source === 'voice')
        || node.turnTimeline?.tone === 'error'
      ))
    ),
    [isVoiceTurn, turn.nodes, turn.status],
  );

  // X5.5-D2 顺手收：startTask 是 fire-and-forget，running 态到达前派活轮短暂呈现
  // 「completed + 有正文」，动作条会先闪一下。通话还在进行时、既无结局印章也无失败
  // 证据的任务轮不渲染动作条；挂断后（phase 回 idle）或印章落下后恢复。
  const suppressReplyActions =
    isVoiceTurn && voiceCallInFlight && !turn.voiceWorkOutcome && !hasVoiceFailureEvidence;

  const handleFork = async () => {
    if (!forkAnchor || isForking || isSessionProcessing || sessionIsRunning) return;
    setIsForking(true);
    try {
      // 单击即分叉：默认「历史对话 + 当前文件」；隔离锚点工作区保留在服务层，前台不给选项
      await createForkFromReply(forkAnchor.messageId, 'shared_current');
    } finally {
      setIsForking(false);
    }
  };

  return (
    <div
      className={`mb-2 transition-colors group/turncard ${
        highlightActive ? 'bg-amber-500/5' : ''
      }`}
    >
      {showSeparator && (
        <div className="flex items-center gap-2 py-1.5">
          <div className="h-px flex-1 bg-zinc-800"></div>
          {/* 只说时间点。轮时长由下面折叠按钮那一处带「用时」标签地讲——
              同一个数字在同一屏出现两次、其中一次还没有标签，正是第 17 条那个歧义。
              UX round2 20i：时间戳每轮常驻可见（低透明度常态、hover 提亮）。
              此前 opacity-0 + group-hover 浮出——滚动时鼠标静止、卡片从光标下穿过，
              :hover 随卡片边界高速翻转，时间戳「开始时间数字会随页面滑动偶尔消失但还在」
              的闪烁就是这条 hover 门控造成的；常驻后闪烁根因消除。 */}
          <span className="text-[10px] text-zinc-500 shrink-0 opacity-60 transition-opacity duration-150 group-hover/turncard:opacity-100">{stats.time}</span>
          <div className="h-px flex-1 bg-zinc-800"></div>
        </div>
      )}

      {/* Content */}
      <div className="space-y-2 px-4">
        {beforeUserMessage}
        {/* User message always at top */}
        {foldedView?.userNode && (
          <TraceNodeRenderer
            node={foldedView.userNode}
            sessionId={sessionId}
            attachments={foldedView.userNode.attachments}
            inVoiceDispatchCard={isVoiceTurn}
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

        {/* 语音派活任务卡卡头：整轮的头一句话——这件活是什么、谁做的。
            不显示任何状态徽章（X5.5 返工批 R4a 产品拍板）：结局判定是 host 证据门的事，
            卡片不转述。过程折叠在卡身里，结论（最后一条有正文的 assistant_text）走下方既有
            finalTextNode 通道留在卡外——过程中模型会穿插「我来做」类过渡文本，
            只有最后一条正文是这轮给用户看的结论，与 Codex 式外壳的切法同一条判据。 */}
        {isVoiceTurn && voiceDispatch && (
          <VoiceDispatchCardHeader
            title={voiceDispatch.title}
            speaker={voiceDispatch.speaker}
            expanded={expanded}
            onToggle={() => setUserExpanded(!expanded)}
          />
        )}

        <TurnRunHeader turn={turn} streamingState={streamingState} />
        {shouldShowStreamingState(streamingState) && (
          <StreamingStateBanner state={streamingState} />
        )}

        {hookActivity && <HookExecutionBanner activity={hookActivity} />}
        {skillActivity && <SkillActivityBanner activity={skillActivity} />}

        {/* "Worked for Xm Ys" toggle — always visible when foldable。
            语音任务卡的展开/收起由上面的卡头承担，不再重复一个折叠钮。 */}
        {canFold && !isVoiceTurn && (
          <button
            onClick={() => setUserExpanded(!expanded)}
            className="flex items-center gap-1.5 text-xs leading-4 text-zinc-500 hover:text-zinc-300 transition-colors py-0.5"
            aria-expanded={expanded}
            title={expanded ? t.turnCard.collapseTurn : t.turnCard.expandTurn}
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3 flex-shrink-0 text-zinc-500" />
            ) : (
              <ChevronRight className="w-3 h-3 flex-shrink-0 text-zinc-500" />
            )}
            <span>
              {t.turnCard.workedFor.replace(
                '{duration}',
                stats.duration ? formatTurnDuration(stats.duration) : '—',
              )}
            </span>
          </button>
        )}

        {/* Middle content (folded: hide; expanded: show all except user) */}
        {!folded && (
          <>
            {/* 一个回合内所有思考段合并成一行「思考」，不再按节点单列（产品拍板）。
                2026-07-28 品质感打磨③：流式思考阶段由 StreamingIndicator 的扫光
                「正在思考…」讲，digest 行让位，不与它并存成两行静态文本。 */}
            {!isThinkingPhase && <ThinkingDigestBanner segments={thinkingSegments} />}
            {displayNodes.map((d, i) => {
              if (d.kind === 'tool_group') {
                return (
                  <ToolStepGroup
                    key={d.key}
                    nodes={d.tools}
                    sessionId={sessionId}
                    defaultExpanded={false}
                    isStreamingTurn={isStreaming}
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
              // 文件改动只由下方的文件变更卡讲一遍：卡片带相对路径 + 增删行数 + diff + 撤销，
              // 节点流里那行工具步骤是纯重复（同一个文件名在一屏里出现三次）。
              if (isFileChangeCardOwnedNode(node)) {
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
                  inVoiceDispatchCard={isVoiceTurn}
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

        {/* 语音任务卡折叠态仍在流式时：过程收在卡身里，live 信号不能全灭——
            底部保留呼吸态指示。 */}
        {isVoiceTurn && folded && isStreaming && turn.nodes.length > 0 && (
          <StreamingIndicator
            startTime={turn.startTime}
            runningToolStartTime={runningToolStartTime}
            showCaret={!lastNodeIsStreamingText}
            isThinking={isThinkingPhase}
            waitingReason={getStreamingWaitingReason(turn.nodes, streamingState.status)}
          />
        )}

        {/* Final AI answer (always shown when foldable; non-foldable turns already rendered in map above) */}
        {canFold && foldedView?.finalTextNode && (
          <TraceNodeRenderer
            node={foldedView.finalTextNode}
            sessionId={sessionId}
            attachments={foldedView.finalTextNode.attachments}
            inVoiceDispatchCard={isVoiceTurn}
            onStreamingDisplayUpdate={onStreamingDisplayUpdate}
          />
        )}

        {/* 产物/来源固定锚点：始终渲染在最终答案之后，位置稳定（与正文内 Sources 一致），
            不再随工具调用在流中的位置而在答案上方/下方漂移。 */}
        {(() => {
          const artifactNode = turn.nodes.find(
            (node) => node.turnTimeline?.kind === 'artifact_ownership',
          );
          return artifactNode ? (
            <TraceNodeRenderer key={artifactNode.id} node={artifactNode} sessionId={sessionId} />
          ) : null;
        })()}

        {/* Turn-level aggregated diff card — always visible */}
        <TurnDiffSummary turn={turn} />

        {/* 评价对象是这一轮的回答，所以位置在整轮最后——挂在正文节点里会插在答案和
            它产出的文件卡之间，看起来像在给上面那一句话打分。
            操作行（复制/好评/差评/分叉）只在最后一轮常驻；历史轮 hover 进入该轮才显示，
            避免多轮会话里每轮都拖一条操作行造成的割裂感（2026-07-29 产品反馈）。 */}
        {(forkAnchor || feedbackAnchor) && !suppressReplyActions && (
          <div
            className={`flex items-center gap-2 ${isLastTurn ? '' : 'opacity-0 transition-opacity duration-150 group-hover/turncard:opacity-100'}`}
            data-testid="turn-reply-actions"
          >
            {feedbackAnchor && (
              <TurnCopyAction content={feedbackAnchor.content} />
            )}
            {feedbackAnchor && (
              <TurnFeedback
                messageId={feedbackAnchor.messageId}
                content={feedbackAnchor.content}
              />
            )}
            {forkAnchor && (
              <button /* ds-allow:button: 与点赞点踩同形的回复操作小图标按钮，Button primitive 无此紧凑图标变体 */
                type="button"
                data-testid="turn-fork-action"
                aria-label={t.turnCard.createForkFromReply}
                title={t.turnCard.createForkFromReply}
                disabled={Boolean(isSessionProcessing) || sessionIsRunning || isForking}
                onClick={() => void handleFork()}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-zinc-500 transition-colors hover:border-violet-500/40 hover:bg-violet-500/10 hover:text-violet-300 focus:outline-hidden focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
              >
                {isForking
                  ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  : <GitFork className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ---- 语音派活任务卡卡头（W6-5）----
// 卡头两要素：这是什么活（title）+ 谁做的（speaker，只有用户点名了专家才有——
// 没有就一个人名都不显示，不编默认署名）。不显示任何状态徽章（X5.5 返工批 R4a
// 产品拍板）：结局判定收在 host 证据门（turn.voiceWorkOutcome 照常落库），卡片不转述。
// 整行是一个 Button primitive（点卡头展开/收起），[&>span] 覆盖是让 Button 内部的
// 单个子 span 撑满整行左对齐——不改变 primitive 本身。
//
// 左缘基线（X5.5 返工批 R4b，真机截图实锤卡头比正文右移一截）：
// 正文（assistant 文本 / 结论气泡）的左缘 = 卡容器 px-4 的内容边；Button size=sm
// 自带 px-3，此前 className 里的 px-2 是死类——TW4 层叠里同族间距大值赢（px-3 盖住
// px-2），与书写顺序无关——于是图标/标题被顶到内容边右 12px。修法不是再写一个新
// px 去压（那是同一条死路），而是保留 px-3 的点击/hover 面积，用 -mx-3 把整行
// 负 margin 回内容边、宽度同步补偿：图标与正文同一左缘，hover 底色外扩进 px-4 排水沟。
const VoiceDispatchCardHeader: React.FC<{
  title: string;
  speaker?: { agentId: string; displayName: string };
  expanded: boolean;
  onToggle: () => void;
}> = ({ title, speaker, expanded, onToggle }) => {
  const { t } = useI18n();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="voice-task-card-header"
      aria-expanded={expanded}
      title={expanded ? t.voice.taskCard.collapseProcess : t.voice.taskCard.expandProcess}
      onClick={onToggle}
      className="-mx-3 w-[calc(100%+1.5rem)] [&>span]:flex [&>span]:w-full [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-2"
    >
      <AudioLines className="h-4 w-4 shrink-0 text-zinc-500" />
      <span className="min-w-0 truncate text-left font-medium text-zinc-300">{title}</span>
      {speaker && (
        <span
          data-testid="voice-task-speaker"
          className="shrink-0 rounded-md border border-border-muted bg-surface-subtle px-1.5 py-0.5 text-[11px] text-zinc-400"
        >
          {speaker.displayName}
        </span>
      )}
      {expanded ? (
        <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600" />
      ) : (
        <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600" />
      )}
    </Button>
  );
};

// UX round2 20i：每轮常驻的「复制回答」小图标按钮，与点赞/点踩/分叉同形同排。
const TurnCopyAction: React.FC<{ content: string }> = ({ content }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!content.trim()) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), UI.COPY_FEEDBACK_DURATION);
    } catch {
      // 剪贴板不可用（权限/非安全上下文）时静默，不阻塞其它操作
    }
  };

  return (
    <button /* ds-allow:button: 「复制回答」是回复操作行的图标级小按钮，Button primitive 无此紧凑图标变体 */
      type="button"
      data-testid="turn-copy-action"
      aria-label={copied ? t.turnCard.answerCopied : t.turnCard.copyAnswer}
      title={copied ? t.turnCard.answerCopied : t.turnCard.copyAnswer}
      onClick={() => void handleCopy()}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-zinc-500 transition-colors hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-300 focus:outline-hidden focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]"
    >
      {copied
        ? <Check className="h-3.5 w-3.5 text-emerald-400" />
        : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
};

const HOOK_EVENT_LABELS: Record<string, string> = {
  UserPromptSubmit: '用户提示提交',
  SessionStart: '会话开始',
  SessionEnd: '会话结束',
  PreToolUse: '工具前',
  PostToolUse: '工具后',
  PostToolUseFailure: '工具失败',
  PermissionRequest: '权限请求',
  PermissionDenied: '权限拒绝',
  PreCompact: '压缩前',
  PostCompact: '压缩后',
  Stop: '停止',
  StopFailure: '停止失败',
  SubagentStart: '子代理开始',
  SubagentStop: '子代理停止',
  PostExecution: '执行后',
  Setup: '初始化',
  Notification: '通知',
  TaskCreated: '任务创建',
  TaskCompleted: '任务完成',
  RoleWake: '角色唤醒',
  VoiceCallStarted: '通话开始',
  VoiceCallPaused: '通话暂停',
  VoiceCallEnded: '通话结束',
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

// 颜色语义：红只给 hook 自身执行出错；「拦下」「改写输入」是 hook 的正常决策，给 amber。
function getHookActivityTone(activity: TurnHookActivity): 'success' | 'warning' | 'error' {
  if (activity.items.some((item) => (item.errorCount || 0) > 0)) return 'error';
  if (activity.items.some((item) => item.action === 'block' || item.modified)) return 'warning';
  return 'success';
}

function getHookStatusText(activity: TurnHookActivity, t: Translations): string {
  const blockedItems = activity.items.filter((item) => item.action === 'block');
  if (blockedItems.length > 0) {
    const base = t.turnHooks.blockedCount.replace('{count}', String(blockedItems.length));
    // 单条拦截直接带原因（首行截断已在 host 侧做过）；多条只计数，原因去展开里看
    const reason = blockedItems.length === 1 ? blockedItems[0]?.reason : undefined;
    return reason ? `${base} · ${t.turnHooks.reason.replace('{reason}', reason)}` : base;
  }
  const errors = activity.items.reduce((sum, item) => sum + (item.errorCount || 0), 0);
  if (errors > 0) return t.turnHooks.errored.replace('{count}', String(errors));
  const modified = activity.items.filter((item) => item.modified).length;
  if (modified > 0) return t.turnHooks.modifiedCount.replace('{count}', String(modified));
  return t.turnHooks.allowed;
}

const HookExecutionBanner: React.FC<{ activity: TurnHookActivity }> = ({ activity }) => {
  // 默认折叠：折叠行已经说清「哪个时机、是哪几个 hook」，展开是给想细看的人留的。
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const tone = getHookActivityTone(activity);
  const statusText = getHookStatusText(activity, t);
  const showStatus = tone !== 'success' && activity.items.length > 0;

  return (
    <div className="py-0.5 text-sm text-zinc-500">
      {activity.items.length > 0 && (
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded-md py-0.5 text-left text-zinc-500 transition-colors hover:text-zinc-300"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={showStatus ? statusText : undefined}
        >
          <Anchor className="h-4 w-4 shrink-0" />
          <span className="shrink-0 font-medium">{t.turnHooks.title}</span>
          {/* 折叠态就说清「哪个时机、是哪几个 hook」——不展开也知道刚才动了什么 */}
          <span className="min-w-0 truncate text-zinc-600">{activity.summary}</span>
          {showStatus && (
            <span className={`max-w-[360px] shrink-0 truncate rounded px-1 py-px text-[11px] ${getHookIssueClass(tone)}`}>
              {statusText}
            </span>
          )}
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
          )}
        </button>
      )}
      {/* 慢 hook 的 running 指示：>300ms 才淡入（CSS delay，无 JS 定时器），
          批次完成（hook_trigger 落账）后随 projection 移除，落为上面的常驻 banner。 */}
      {activity.running && (
        <div className="hook-running-enter flex items-center gap-2 py-0.5" data-testid="hook-running-indicator">
          <Anchor className="h-4 w-4 shrink-0 animate-pulse" />
          <span className="streaming-thinking-shimmer font-medium">
            {t.turnHooks.title} · {t.turnHooks.running.replace('{event}', HOOK_EVENT_LABELS[activity.running.event] || activity.running.event)}
          </span>
        </div>
      )}
      {expanded && activity.items.length > 0 && (
        <div className="ml-7 mt-1 space-y-1 text-[13px] leading-5 text-zinc-500">
          {activity.items.map((item, index) => {
            const label = HOOK_EVENT_LABELS[item.event] || item.event;
            // 「是哪几个 hook」用配置里的 name（没写就退回脚本名），不再拿 hook 的输出原文顶替——
            // 那份原文是任意内容，实测把整份记忆索引连 HTML 注释一起漏给了用户。
            // 来源(全局/项目)、可干预/仅观察对非程序员是噪音，连 hover tooltip 也不放。
            const injectedContentLabel = (item.names || []).join('、') || item.toolName || item.matcher || undefined;
            const title = injectedContentLabel;
            const itemStatus = getHookItemStatusText(item, t);
            return (
              <div
                key={`${item.event}-${item.timestamp}-${index}`}
                className="min-w-0"
                title={title || undefined}
              >
                <div className="flex min-w-0 items-center gap-1.5">
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
                {/* 决策原因（block/modify 的首行摘要，host 侧已截断+脱敏）是唯一上屏的
                    hook 文本；Stop hook 拦下收尾时这行就是「为什么还要求继续」。 */}
                {item.reason && (item.action === 'block' || item.modified) && (
                  <div className="mt-0.5 truncate text-amber-200/70" title={item.reason}>
                    {t.turnHooks.reason.replace('{reason}', item.reason)}
                  </div>
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
      return '本轮挂载';
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
  t: Translations,
): { label: string; tone: 'warning' | 'error' } | null {
  // 拦下/改写是 hook 的正常决策（amber）；Stop 系拦下是「要求 agent 继续」，措辞区分开
  if (item.action === 'block') {
    const isStopGate = item.event === 'Stop' || item.event === 'StopFailure';
    return { label: isStopGate ? t.turnHooks.stopBlocked : t.turnHooks.blocked, tone: 'warning' };
  }
  // 只有 hook 自身执行出错才用红
  if ((item.errorCount || 0) > 0) return { label: t.turnHooks.errored.replace('{count}', String(item.errorCount)), tone: 'error' };
  if (item.modified) return { label: t.turnHooks.modified, tone: 'warning' };
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

  // 这里曾经用路由摘要当轮次阶段（「已指定 岚析 执行」），既是内部审计口径，又跟
  // 旁边的 Auto 徽章自相矛盾。阶段该说这一轮在做什么，落到下面的能力/工具描述。

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
      return 'border-border-muted bg-surface-subtle text-zinc-400';
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
        <div className="inline-flex items-center gap-1 rounded-md bg-surface-subtle px-1.5 py-0.5 text-[11px] text-zinc-500">
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
