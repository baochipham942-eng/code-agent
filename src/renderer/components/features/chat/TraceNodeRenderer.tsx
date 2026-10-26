// ============================================================================
// TraceNodeRenderer - Render individual trace nodes by type
// Reuses existing MessageContent, ToolCallDisplay components; UserNode below
// is its own implementation (not MessageBubble/UserMessage.tsx, which was
// dead code removed in ADR-043 T2 遗留刀2).
// ============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { TraceNode } from '@shared/contract/trace';
import type { ToolCall } from '@shared/contract';
import type { FileChange } from '../../../utils/turnDiffSummary';
import { stripAppshotBlocks } from '@shared/contract/appshot';
import { extractUserRequest, stripSystemReminderBlocks } from '@shared/utils/turnScaffold';
import { normalizeSpokenFileName } from '@shared/utils/normalizeSpokenFileName';
import { MessageContent } from './MessageBubble/MessageContent';
import { restoreNeoTagTokenForDisplay } from './MessageBubble/triggerTokenHighlight';
import { ToolCallDisplay } from './MessageBubble/ToolCallDisplay/index';
import { AttachmentDisplay } from './MessageBubble/AttachmentPreview';
import { ExpandableContent } from './ExpandableContent';
import { LaunchRequestCard } from '../swarm/LaunchRequestCard';
import { undeclaredToolDisplayName } from '../../../utils/humanizeToolStep';
import { SkillStatusMessage } from './MessageBubble/SkillStatusMessage';
import { GoalNoticeMessage } from './MessageBubble/GoalNoticeMessage';
import { FallbackBanner } from './MessageBubble/FallbackBanner';
import { ContextCompressionSignalBanner } from './MessageBubble/ContextCompressionSignalBanner';
import { RouteTraceChip, shouldRenderModelDecisionChip } from './RouteTraceChip';
import { TurnQualityStrip } from './TurnQualityStrip';
import { AgentErrorPresentation } from './AgentErrorCard';
import { VoiceCallSummaryCard } from '../voice/VoiceCallSummaryCard';
import { useSmoothStreamingText } from '../../../hooks/useSmoothStreamingText';
import { Archive, AudioLines, ChevronDown, ChevronRight, AlertTriangle, Copy, Check, RefreshCw, RotateCcw } from 'lucide-react';
import { UI } from '@shared/constants';
import { humanizeToolError } from '../../../utils/toolExecutionPresentation';
import { useI18n } from '../../../hooks/useI18n';
import { interpolate } from '../../../i18n/interpolate';
import { useMessageActionStore } from '../../../stores/messageActionStore';
import { useAppStore } from '../../../stores/appStore';
import { useStreamResumeStore } from '../../../stores/streamResumeStore';
import { MemberInputNote } from '../expert/MemberInputNote';
import { WakeRationaleNote, wakeRationaleFromMetadata } from './WakeRationaleNote';
import { TurnTimelineNodeRenderer } from './TraceTimelineNodes';
import { MessageContextFrame, MessageContextMenu } from './MessageContextMenu';
import { messageContextMenuId } from './useMessageContextInterventions';

interface TraceNodeRendererProps {
  node: TraceNode;
  sessionId?: string;
  /** Message attachments for user nodes */
  attachments?: import('@shared/contract').MessageAttachment[];
  /** Whether this node is in a currently streaming turn */
  isStreaming?: boolean;
  /**
   * X5.5-D4/D6：节点处于语音派活任务卡内。徽标已上提到轮层（卡头 AudioLines
   * 图标是这通派活唯一的语音标记），轮内节点级的「语音」小标全部抑制。
   */
  inVoiceDispatchCard?: boolean;
  onStreamingDisplayUpdate?: (nodeId: string, displayLength: number, isAnimating: boolean) => void;
  onRewindUserPrompt?: (messageId: string, content: string) => void;
  rewindDisabled?: boolean;
  fileChangesByPath?: ReadonlyMap<string, FileChange>;
}

export const TraceNodeRenderer: React.FC<TraceNodeRendererProps> = ({
  node,
  sessionId,
  attachments,
  isStreaming,
  inVoiceDispatchCard,
  onStreamingDisplayUpdate,
  onRewindUserPrompt,
  rewindDisabled,
  fileChangesByPath,
}) => {
  let content: React.ReactNode;

  switch (node.type) {
    case 'user':
      content = (
        <UserNode
          messageId={messageContextMenuId(node) ?? node.id}
          sessionId={sessionId}
          content={node.content}
          attachments={attachments}
          sourceType={node.metadata?.source}
          sendFailed={node.metadata?.sendFailed === true}
          suppressVoiceBadge={Boolean(inVoiceDispatchCard)}
          isNeoTagMessage={Boolean(node.metadata?.neoTag)}
          streaming={isStreaming}
          onRewind={onRewindUserPrompt}
          rewindDisabled={rewindDisabled}
        />
      );
      break;
    case 'assistant_text':
      // 用户给成员补话的折叠记录（isMeta + memberInput）：一行灰字，不走助手气泡
      if (node.metadata?.memberInput) {
        content = <MemberInputNote node={node} />;
        break;
      }
      content = (
        <AssistantTextNode
          node={node}
          sessionId={sessionId}
          isStreaming={isStreaming}
          inVoiceDispatchCard={inVoiceDispatchCard}
          onStreamingDisplayUpdate={onStreamingDisplayUpdate}
        />
      );
      break;
    case 'tool_call':
      content = <ToolCallNode node={node} sessionId={sessionId} />;
      break;
    case 'system':
      content = <SystemNode node={node} sessionId={sessionId} />;
      break;
    case 'neo_work_card':
      // 轻量化重设计：@neo = 正常 agent 聊天,会话里不再渲染独立工作卡(2026-07-02 产品负责人拍板)。
      // 历史/产物在账号菜单「Neo 协同」topic 目录看。
      return null;
    case 'swarm_launch_request':
      content = <LaunchRequestNode node={node} />;
      break;
    case 'turn_timeline':
      if (!node.turnTimeline) return null;
      if (
        node.turnTimeline.kind === 'workbench_snapshot' ||
        node.turnTimeline.kind === 'capability_scope'
      ) {
        return null;
      }
      content = (
        <TurnTimelineNodeRenderer
          node={node}
          sessionId={sessionId}
          isStreaming={isStreaming}
          fileChangesByPath={fileChangesByPath}
        />
      );
      break;
    default:
      return null;
  }

  return (
    <div data-trace-node-id={node.id} data-trace-node-type={node.type}>
      {content}
    </div>
  );
};

// ---- User Node ----
const UserNode: React.FC<{
  messageId: string;
  sessionId?: string;
  content: string;
  attachments?: import('@shared/contract').MessageAttachment[];
  /** 输入来源（§8.2）：voice/dictation 的气泡加来源小标 */
  sourceType?: 'voice' | 'dictation' | 'typed';
  /** 发送失败后留在时间线上的乐观用户气泡 */
  sendFailed?: boolean;
  /** X5.5-D4：语音任务卡内抑制节点级「语音」小标（轮头已显示一次） */
  suppressVoiceBadge?: boolean;
  isNeoTagMessage?: boolean;
  onRewind?: (messageId: string, content: string) => void;
  rewindDisabled?: boolean;
  streaming?: boolean;
}> = ({ messageId, sessionId, content, attachments, sourceType, sendFailed, suppressVoiceBadge, isNeoTagMessage, onRewind, rewindDisabled, streaming }) => {
  const { t } = useI18n();
  const editAndResendMessage = useMessageActionStore((state) => state.editAndResendMessage);
  // 展示面还原：带 turnSystemContext 脚手架（<user_request> 包裹）的历史/泄漏消息只显示
  // 用户原话——包装是模型面，用户界面显示原话（UX round2 20f，定义在 shared/utils/turnScaffold）。
  // @neo 落库正文被剥了前缀（它兼任模型 prompt），渲染时补回展示，重启后也能看到带色的 @neo
  const rawDisplayContent = restoreNeoTagTokenForDisplay(
    stripSystemReminderBlocks(stripAppshotBlocks(extractUserRequest(content || ''))),
    Boolean(isNeoTagMessage),
  );
  const displayContent = sourceType === 'voice'
    ? normalizeSpokenFileName(rawDisplayContent)
    : rawDisplayContent;
  const showUserChrome = Boolean(displayContent) || sendFailed;

  return (
    <div>
      {/* 轮次 chip 行已移除（2026-07-29 产品反馈）：专家/skill/连接器/pin/命令不在
          消息上方独立展示，由模型在回答里自然说明用了什么；metadata 仍落库备遥测。 */}
      {attachments && attachments.length > 0 && (
        <div className="mb-2">
          <AttachmentDisplay
            attachments={attachments}
            mediaContext={{ sessionId, messageId }}
          />
        </div>
      )}
      {showUserChrome && (
        <div className="flex justify-end">
          <div className="max-w-[86%]">
            {sourceType === 'voice' && !suppressVoiceBadge && (
              <div data-testid="voice-source-badge" className="mb-1 flex items-center justify-end gap-1 text-2xs text-zinc-500">
                <AudioLines className="h-3 w-3" />
                <span>{t.voice.sourceBadge}</span>
              </div>
            )}
            {sendFailed && (
              <div
                data-testid="user-message-send-failed"
                className="mb-1 flex items-center justify-end gap-2 text-2xs text-badge-danger/90"
              >
                <AlertTriangle className="h-3 w-3" />
                <span>{t.turnCard.sendFailed}</span>
                <button
                  type="button"
                  data-testid="user-message-edit-resend"
                  onClick={() => editAndResendMessage(messageId)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-badge-danger/80 transition-colors hover:bg-red-500/10 hover:text-badge-danger focus:outline-hidden focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]"
                >
                  {t.turnCard.editAndResend}
                </button>
              </div>
            )}
            {displayContent && (
              <div className="group/user-prompt flex items-start gap-1.5">
                {onRewind && (
                  <button
                    type="button"
                    onClick={() => onRewind(messageId, displayContent)}
                    disabled={rewindDisabled}
                    className="mt-1 flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 opacity-0 pointer-events-none transition-colors group-hover/user-prompt:opacity-100 group-hover/user-prompt:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-hidden hover:text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
                    title={rewindDisabled ? '会话运行中，暂不能回退' : '回到这条提示词'}
                    aria-label="回到这条提示词"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                )}
                <MessageContextMenu sessionId={sessionId} messageId={messageId} placement="user" streaming={streaming} />
                <MessageContextFrame sessionId={sessionId} messageId={messageId}>
                <div className={`rounded-2xl px-4 py-2.5 bg-zinc-800/60 border ${sendFailed ? 'border-red-500/40' : 'border-border-muted'}`}>
                  <div className="text-zinc-200 leading-relaxed select-text">
                    <MessageContent
                      content={displayContent}
                      isUser={true}
                      messageId={messageId}
                      mediaContext={{ sessionId, messageId }}
                    />
                  </div>
                </div>
                </MessageContextFrame>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ---- Assistant Text Node ----
interface SelectionCopyState {
  text: string;
  top: number;
  left: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getSelectionCopyState(root: HTMLElement | null, content: HTMLElement | null): SelectionCopyState | null {
  if (!root || !content || typeof window === 'undefined') return null;

  const selection = window.getSelection?.();
  const selectedText = selection?.toString() || '';
  if (!selection || selection.rangeCount === 0 || selectedText.trim().length === 0) {
    return null;
  }

  if (!selection.anchorNode || !selection.focusNode) return null;
  if (!content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const selectionRect = range.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  if (!selectionRect.width && !selectionRect.height) return null;

  const buttonWidth = 32;
  const buttonHeight = 30;
  const offset = 6;
  const maxLeft = Math.max(0, rootRect.width - buttonWidth);
  const maxTop = Math.max(0, rootRect.height - buttonHeight);
  const topAboveSelection = selectionRect.top - rootRect.top - buttonHeight - offset;
  const topBelowSelection = selectionRect.bottom - rootRect.top + offset;

  return {
    text: selectedText,
    left: clamp(selectionRect.right - rootRect.left - buttonWidth, 0, maxLeft),
    top: clamp(topAboveSelection >= 0 ? topAboveSelection : topBelowSelection, 0, maxTop),
  };
}

const AssistantTextNode: React.FC<{
  node: TraceNode;
  sessionId?: string;
  isStreaming?: boolean;
  /** X5.5-D4/D6：语音任务卡内抑制节点级语音小标与派活 label（轮头已讲） */
  inVoiceDispatchCard?: boolean;
  onStreamingDisplayUpdate?: (nodeId: string, displayLength: number, isAnimating: boolean) => void;
}> = ({ node, sessionId, isStreaming: turnStreaming, inVoiceDispatchCard, onStreamingDisplayUpdate }) => {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasReportingStreamingDisplayRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const [selectionCopy, setSelectionCopy] = useState<SelectionCopyState | null>(null);
  const messageId = node.messageId || (node.id.endsWith('-text') ? node.id.slice(0, -5) : node.id);
  const contextMenuId = messageContextMenuId(node);
  // ADR-068 刀 4：断流续接信号只挂断流那一刻的 streaming 消息（一屏一个信号；B2 分段后
  // 即定格的断点段），续答 delta 到达即消除（store 侧 resolveIfActivityOn）。
  const resumeSignal = useStreamResumeStore(
    (state) => (state.signal?.messageId === messageId ? state.signal : null),
  );
  // 一次性续接说明只在该会话仍在处理（流中）时渲染（ai-review Important）：metadata 本身
  // 不保证「仅流中」——任何持久化/回灌路径带上它时，空闲/重载视图也不许再显示说明。
  const sessionLive = useAppStore((state) => (sessionId ? state.processingSessionIds.has(sessionId) : false));
  const resumeNote = sessionLive ? node.metadata?.streamResumeNote : undefined;
  const keptBreakSegment = node.metadata?.streamInterruptionReason === 'stream-break';
  const wakeFields = wakeRationaleFromMetadata(node.metadata);

  const { displayContent, isAnimating, tailStartIndex } = useSmoothStreamingText({
    content: node.content || '',
    isStreaming: Boolean(turnStreaming),
  });

  useEffect(() => {
    const isDisplayingStream = Boolean(turnStreaming || isAnimating);

    if (isDisplayingStream) {
      wasReportingStreamingDisplayRef.current = true;
      onStreamingDisplayUpdate?.(node.id, displayContent.length, isAnimating);
      return;
    }

    if (!wasReportingStreamingDisplayRef.current) return;
    wasReportingStreamingDisplayRef.current = false;
    onStreamingDisplayUpdate?.(node.id, displayContent.length, false);
  }, [displayContent.length, isAnimating, node.id, onStreamingDisplayUpdate, turnStreaming]);

  const updateSelectionCopy = useCallback(() => {
    setSelectionCopy(getSelectionCopyState(rootRef.current, contentRef.current));
  }, []);

  useEffect(() => {
    if (!selectionCopy) return;
    const handleSelectionChange = () => {
      setSelectionCopy(getSelectionCopyState(rootRef.current, contentRef.current));
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, [selectionCopy]);

  const handleCopySelection = useCallback(async () => {
    if (!selectionCopy?.text.trim()) return;
    await navigator.clipboard.writeText(selectionCopy.text);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      setSelectionCopy(null);
    }, UI.COPY_FEEDBACK_DURATION);
  }, [selectionCopy]);

  // 空壳守卫：空正文 + 无路由/质量信号 = 没有任何可渲染内容，整节点跳过，避免线性
  // trace 里出现无法解释的空白行。思考不在这里渲染——一个回合内所有思考段已经在
  // TurnCard 合并成一个「思考」折叠块（ThinkingDigestBanner），纯思考节点因此
  // 在这条独立路径上正确地渲染成"无"，不是遗漏。
  const hasRenderableContent = Boolean(
    node.content
    || (node.modelDecision && shouldRenderModelDecisionChip(node.modelDecision))
    || node.metadata?.turnQuality
    || node.metadata?.agentError
    // ADR-068 刀 4：B2 续答段刚起头时正文还空，一次性续接说明先于首字渲染
    || resumeNote
    || resumeSignal,
  );
  // 排查报告 §2 序列②：活动轮里「thinking 已结束但 content 尚空」的窗口——思考指示已经
  // 灭了（TurnCard.tsx 的 isThinkingPhase 判定同一节点 thinking 也空），这条守卫又让节点
  // 整节点不渲染，用户看到的是彻底的空白。只在这条活动轮窗口渲染一个轻占位，别的空壳
  // （历史消息、仍在思考中的节点）保持原样不渲染，不动既有折叠/思考展示逻辑。
  const isActiveEmptyGap =
    turnStreaming && !hasRenderableContent && !(node.thinking || node.reasoning)?.trim();
  if (!hasRenderableContent) {
    if (!isActiveEmptyGap) return null;
    return (
      <div className="py-1" aria-label={t.chat.organizingReply}>
        <span className="streaming-thinking-shimmer text-xs font-medium">{t.chat.organizingReply}</span>
      </div>
    );
  }

  const assistantTextBody = node.content ? (
    <div ref={contentRef} className="text-zinc-200 leading-relaxed select-text">
      <MessageContent
        content={displayContent}
        isUser={false}
        isStreaming={Boolean(turnStreaming || isAnimating)}
        messageId={messageId}
        streamingTailStart={tailStartIndex}
        mediaContext={{ sessionId, messageId }}
      />
      {(turnStreaming || isAnimating) && (
        <span className="sr-only">正在生成</span>
      )}
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      aria-label="助手消息"
      className="relative group/msg"
      onMouseUp={updateSelectionCopy}
      onKeyUp={updateSelectionCopy}
    >
      {selectionCopy && (
        <div
          className="absolute z-20"
          style={{ top: selectionCopy.top, left: selectionCopy.left }}
        >
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleCopySelection}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700 bg-zinc-800/95 text-zinc-300 shadow-lg transition-colors hover:bg-zinc-700 hover:text-zinc-100"
            title="复制选中文本"
            aria-label="复制选中文本"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-badge-success" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      )}

      {node.modelDecision && shouldRenderModelDecisionChip(node.modelDecision) && (
        <div className="mb-2 flex min-w-0">
          <RouteTraceChip
            decision={node.modelDecision}
            defaultExpanded={Boolean(node.modelDecision.externalEngine?.failure)}
          />
        </div>
      )}

      {node.metadata?.turnQuality && (
        <TurnQualityStrip summary={node.metadata.turnQuality} />
      )}

      {node.metadata?.source === 'voice' && !node.metadata?.voiceDispatch && !inVoiceDispatchCard && (
        <div data-testid="voice-source-badge" className="mb-1 flex items-center gap-1 text-2xs text-zinc-500">
          <AudioLines className="h-3 w-3" />
          <span>{t.voice.sourceBadge}</span>
        </div>
      )}

      {/* 通话 brain 改写后发给执行引擎的指令——不是用户说的话，必须写明来源。
          X5.5-D6：语音任务卡内整条不渲染——卡头已显示同一个 title，
          label 里的「{title}」与卡头读同一字段，必然重复。 */}
      {node.metadata?.voiceDispatch && !inVoiceDispatchCard && (
        <div data-testid="voice-dispatch-label" className="mb-1 flex items-center gap-1 text-2xs text-zinc-500">
          <AudioLines className="h-3 w-3" />
          <span>{t.voice.dispatchLabel.replace('{title}', node.metadata.voiceDispatch.title)}</span>
        </div>
      )}

      {/* ADR-068 刀 4：B2 续答段的一次性续接说明（仅流中，host 不落库、重载不出现） */}
      {resumeNote && (
        <div data-testid="stream-resume-note" className="mb-1 flex items-center gap-1 text-2xs text-zinc-500">
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          <span>{t.chat.streamResumeSegmentNote}</span>
        </div>
      )}

      {/* Text content. Badge only on the feedback-eligible final reply. */}
      {node.content && (
        contextMenuId ? (
          <MessageContextFrame sessionId={sessionId} messageId={contextMenuId}>
            {assistantTextBody}
          </MessageContextFrame>
        ) : assistantTextBody
      )}

      {/* ADR-068 刀 4（D5）：断流续接状态行——同一 streaming 消息内嵌，一屏一个信号；
          续答恢复（B1 无缝续打 / B2 落到续答段）或终态一到即消除。 */}
      {resumeSignal && (
        <div
          data-testid="stream-resume-status"
          role="status"
          className="mt-1 flex items-center gap-1.5 text-2xs text-zinc-400"
        >
          <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
          <span>
            {interpolate(t.chat.streamResumeReconnecting, {
              n: resumeSignal.attempt,
              N: resumeSignal.maxReconnects,
            })}
          </span>
        </div>
      )}

      {/* B2 断点段（重载视图）：中断语义样式行——裸协议标记已在投影层剥掉不上屏 */}
      {keptBreakSegment && !resumeSignal && (
        <div data-testid="stream-break-kept-segment" className="mt-1 text-2xs text-zinc-500">
          {t.chat.streamBreakKeptSegment}
        </div>
      )}

      {/* 运行失败的结构化错误卡片（替代旧版 merge 进正文的 ⚠ 文本） */}
      {node.metadata?.agentError && (
        <AgentErrorPresentation
          error={node.metadata.agentError}
          messageId={messageId}
          sessionId={sessionId}
        />
      )}

      {wakeFields ? <WakeRationaleNote fields={wakeFields} /> : null}

    </div>
  );
};

// ---- Tool Call Node ----
const ToolCallNode: React.FC<{ node: TraceNode; sessionId?: string }> = ({ node, sessionId }) => {
  if (!node.toolCall) return null;
  const interruptionReason = node.metadata?.streamInterruptionReason;

  // Reconstruct ToolCall object for ToolCallDisplay
  // 必须把语义字段（shortDescription / targetContext / expectedOutcome）一起带回来，
  // 否则 ToolCallDisplay / ToolHeader 拿不到，会 fallback 到机械路径并多渲染重复信息
  const toolCall: ToolCall = {
    id: node.toolCall.id,
    name: node.toolCall.name,
    arguments: node.toolCall.args,
    _streaming: node.toolCall._streaming,
    shortDescription: node.toolCall.shortDescription,
    stepLabel: node.toolCall.stepLabel,
    targetContext: node.toolCall.targetContext,
    expectedOutcome: node.toolCall.expectedOutcome,
    result: node.toolCall.result !== undefined ? {
      toolCallId: node.toolCall.id,
      success: node.toolCall.success ?? true,
      output: node.toolCall.success !== false ? node.toolCall.result : undefined,
      error: node.toolCall.success === false ? node.toolCall.result : undefined,
      duration: node.toolCall.duration,
      outputPath: node.toolCall.outputPath,
      // 投影层的 recovered 标记要随 result.metadata 带给 ToolCallDisplay（同 ToolStepGroup
      // 的构造路径），否则已恢复的失败行仍按普通失败渲染「未成功」+ 失败原因行。
      metadata: node.toolCall.recovered
        ? { ...(node.toolCall.metadata || {}), recovered: true }
        : node.toolCall.metadata,
    } : undefined,
    liveOutput: node.toolCall.liveOutput,
  };

  return (
    <ToolCallDisplay
      toolCall={toolCall}
      index={0}
      total={1}
      statusOverride={node.metadata?.streamRecovery || interruptionReason ? 'interrupted' : undefined}
      interruptionReason={interruptionReason ?? (node.metadata?.streamRecovery ? 'app-restart' : undefined)}
      mediaContext={{ sessionId, messageId: node.messageId || node.id }}
    />
  );
};

const LaunchRequestNode: React.FC<{ node: TraceNode }> = ({ node }) => {
  if (!node.launchRequest) return null;

  return (
    <div className="py-1">
      <LaunchRequestCard request={node.launchRequest} />
    </div>
  );
};

// ---- System error node ----
// 系统错误原文(往往是堆栈/工程报错)对非程序员用户是噪音：先给一句人话+建议，
// 原文进「查看详情」折叠。分类复用 humanizeToolError（quota/rate_limit/auth/
// overloaded/timeout/network 已有文案），分不出类别时给通用兜底。
const SystemErrorNode: React.FC<{ node: TraceNode }> = ({ node }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const failureDetail = node.metadata?.voiceWorkFailure?.detail;
  const humanized = failureDetail === undefined ? humanizeToolError(node.content, undefined, t) : null;
  const summary = failureDetail === undefined
    ? humanized?.summary ?? t.systemError.fallbackSummary
    : t.rendererHumanPipe.systemError.voiceFailureSummary;
  const detail = failureDetail === undefined
    ? humanized?.detail ?? t.systemError.fallbackDetail
    : t.rendererHumanPipe.systemError.voiceFailureDetail;
  const expandableDetail = failureDetail ?? node.content;

  return (
    <div className="py-1">
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
        <AlertTriangle className="w-4 h-4 text-badge-danger mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-badge-danger">{summary}</div>
          {detail && <div className="mt-0.5 text-[11px] text-badge-danger/70">{detail}</div>}
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="shrink-0 text-[11px] text-badge-danger/70 hover:text-badge-danger transition-colors"
        >
          {expanded ? t.systemError.hideDetails : t.systemError.viewDetails}
        </button>
      </div>
      {expanded && expandableDetail && (
        <div className="mt-2 px-3 py-2.5 rounded-md bg-red-500/5 border border-red-500/10">
          <ExpandableContent content={expandableDetail} maxLines={30} />
        </div>
      )}
    </div>
  );
};

// ---- System Node ----
const SystemNode: React.FC<{ node: TraceNode; sessionId?: string }> = ({ node, sessionId }) => {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();

  const checkoutNote = node.metadata?.turnCheckoutNote;
  if (checkoutNote) {
    const title = checkoutNote.operation === 'redo'
      ? checkoutNote.state === 'success'
        ? t.chat.turnCheckoutNoteRedoSuccess
        : t.chat.turnCheckoutNoteRedoPartial
      : checkoutNote.state === 'success'
        ? t.chat.turnCheckoutSuccess
        : t.chat.turnCheckoutPartial;
    const skipped = checkoutNote.skippedFiles.map((item) => {
      // uncertain 披露键是合成串（uncertain-redirection:$OUT/a.txt）不是路径，
      // 取 basename 会剪出误导片段，整串展示
      const file = item.reason === 'uncertain_write_target'
        ? item.filePath
        : item.filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? item.filePath;
      // 未声明工具写盘（undeclared-tool:<name>）按工具披露，不剪路径
      if (item.reason === 'undeclared_tool_write') return t.chat.turnCheckoutNoteUndeclaredTool.replace('{tool}', undeclaredToolDisplayName(item.toolName ?? item.filePath));
      const template = item.reason === 'human_edit'
        ? t.chat.turnCheckoutNoteHumanEdit
        : item.reason === 'missing_post_write_digest'
          ? t.chat.turnCheckoutNoteLegacyDigest
          : item.reason === 'uncertain_write_target'
            ? t.chat.turnCheckoutNoteUncertainTarget
            : t.chat.turnCheckoutNoteSnapshotFailed;
      return template.replace('{file}', file);
    });
    const otherFailures = checkoutNote.failed
      .filter((item) => item.step !== 'workspace')
      .map((item) => `${item.step}: ${item.reason}`);
    return (
      <div className="mx-3 my-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
        <div className="font-medium text-zinc-300">{title}</div>
        <div className="mt-1">
          {t.chat.turnCheckoutNoteChanged.replace('{count}', String(checkoutNote.changedFileCount))}
        </div>
        {[...skipped, ...otherFailures].map((line) => <div key={line} className="mt-1">{line}</div>)}
        <div className="mt-1 text-zinc-500">{t.chat.turnCheckoutExternalEffects}</div>
      </div>
    );
  }

  if (node.subtype === 'compaction') {
    return (
      <div className="py-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-amber-500/10 border border-badge-warning/20 hover:bg-amber-500/15 transition-colors"
        >
          <Archive className="w-4 h-4 text-badge-warning" />
          <span className="text-xs font-medium text-badge-warning">上下文已压缩</span>
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-badge-warning ml-auto" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-badge-warning ml-auto" />
          )}
        </button>
        {expanded && (
          <div className="mt-2 px-3 py-2.5 rounded-md bg-amber-500/5 border border-badge-warning/10">
            <ExpandableContent content={node.content} maxLines={30} />
          </div>
        )}
      </div>
    );
  }

  if (node.subtype === 'error') {
    return <SystemErrorNode node={node} />;
  }

  if (node.subtype === 'skill_status') {
    return <SkillStatusMessage content={node.content} />;
  }

  if (node.subtype === 'goal_notice') {
    return (
      <GoalNoticeMessage
        content={node.content}
        messageId={node.messageId ?? node.id}
        sessionId={sessionId}
      />
    );
  }

  if (node.subtype === 'model_fallback') {
    return <FallbackBanner content={node.content} />;
  }

  if (node.subtype === 'context_compression_signal') {
    return <ContextCompressionSignalBanner content={node.content} />;
  }

  if (node.subtype === 'voice_call_summary' && node.metadata?.voiceCallSummary) {
    return <VoiceCallSummaryCard summary={node.metadata.voiceCallSummary} />;
  }

  // generic system
  return (
    <div className="px-3 py-1.5 text-xs text-zinc-500 italic">
      {node.content}
    </div>
  );
};
