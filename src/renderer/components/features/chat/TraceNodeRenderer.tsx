// ============================================================================
// TraceNodeRenderer - Render individual trace nodes by type
// Reuses existing MessageContent, ToolCallDisplay, UserMessage components
// ============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { TraceNode } from '@shared/contract/trace';
import type { ToolCall } from '@shared/contract';
import type { WorkbenchMessageMetadata } from '@shared/contract/conversationEnvelope';
import type { TurnTimelineNode as TurnTimelinePayload } from '@shared/contract/turnTimeline';
import { MessageContent } from './MessageBubble/MessageContent';
import { ToolCallDisplay } from './MessageBubble/ToolCallDisplay/index';
import { AttachmentDisplay } from './MessageBubble/AttachmentPreview';
import { FileArtifactCard } from './MessageBubble/FileArtifactCard';
import { ExpandableContent } from './ExpandableContent';
import { LaunchRequestCard } from '../swarm/LaunchRequestCard';
import { WorkbenchPill } from '../../workbench/WorkbenchPrimitives';
import { sanitizeThinkingForDisplay } from '../../../utils/toolGrouping';
import { isReadOnlyArtifactOwnershipItem } from '../../../utils/artifactOwnership';
import { SkillStatusMessage } from './MessageBubble/SkillStatusMessage';
import { useSmoothStreamingText } from '../../../hooks/useSmoothStreamingText';
import { Archive, ChevronDown, ChevronRight, AlertTriangle, Copy, Check, FileText, GitBranch, RotateCcw, Wrench, CornerDownRight } from 'lucide-react';
import { UI } from '@shared/constants';

interface TraceNodeRendererProps {
  node: TraceNode;
  /** Message attachments for user nodes */
  attachments?: import('@shared/contract').MessageAttachment[];
  /** Whether this node is in a currently streaming turn */
  isStreaming?: boolean;
  onStreamingDisplayUpdate?: (nodeId: string, displayLength: number, isAnimating: boolean) => void;
  onRewindUserPrompt?: (messageId: string, content: string) => void;
  rewindDisabled?: boolean;
}

export const TraceNodeRenderer: React.FC<TraceNodeRendererProps> = ({
  node,
  attachments,
  isStreaming,
  onStreamingDisplayUpdate,
  onRewindUserPrompt,
  rewindDisabled,
}) => {
  let content: React.ReactNode = null;

  switch (node.type) {
    case 'user':
      content = (
        <UserNode
          messageId={node.id}
          content={node.content}
          attachments={attachments}
          metadata={node.metadata?.workbench}
          onRewind={onRewindUserPrompt}
          rewindDisabled={rewindDisabled}
        />
      );
      break;
    case 'assistant_text':
      content = (
        <AssistantTextNode
          node={node}
          isStreaming={isStreaming}
          onStreamingDisplayUpdate={onStreamingDisplayUpdate}
        />
      );
      break;
    case 'tool_call':
      content = <ToolCallNode node={node} />;
      break;
    case 'system':
      content = <SystemNode node={node} />;
      break;
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
      content = <TurnTimelineNodeRenderer node={node} />;
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
const ROUTING_LABELS: Record<string, string> = {
  auto: 'Auto',
  direct: 'Direct',
  parallel: 'Parallel',
};

function getBrowserWorkbenchLabel(mode: 'managed' | 'desktop'): string {
  return mode === 'managed' ? 'Browser Managed' : 'Browser Desktop';
}

const WorkbenchSummary: React.FC<{ metadata?: WorkbenchMessageMetadata }> = ({ metadata }) => {
  if (!metadata) return null;

  const items: string[] = [];
  if (metadata.workingDirectory) {
    const label = metadata.workingDirectory.split('/').filter(Boolean).pop() || metadata.workingDirectory;
    items.push(`WS ${label}`);
  }
  if (metadata.routingMode) {
    items.push(ROUTING_LABELS[metadata.routingMode] || metadata.routingMode);
  }

  const targets = metadata.targetAgentNames?.length
    ? metadata.targetAgentNames
    : metadata.targetAgentIds || [];
  const selectedSkills = metadata.selectedSkillIds || [];
  const selectedConnectors = metadata.selectedConnectorIds || [];
  const selectedMcpServers = metadata.selectedMcpServerIds || [];
  const browserSessionMode = metadata.executionIntent?.browserSessionMode;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {items.map((item) => (
        <WorkbenchPill
          key={item}
          tone="neutral"
        >
          {item}
        </WorkbenchPill>
      ))}
      {targets.map((target) => (
        <WorkbenchPill
          key={target}
          tone="agent"
        >
          @{target}
        </WorkbenchPill>
      ))}
      {selectedSkills.map((skillId) => (
        <WorkbenchPill
          key={`skill-${skillId}`}
          tone="skill"
        >
          Skill {skillId}
        </WorkbenchPill>
      ))}
      {selectedConnectors.map((connectorId) => (
        <WorkbenchPill
          key={`connector-${connectorId}`}
          tone="connector"
        >
          Connector {connectorId}
        </WorkbenchPill>
      ))}
      {selectedMcpServers.map((serverId) => (
        <WorkbenchPill
          key={`mcp-${serverId}`}
          tone="mcp"
        >
          MCP {serverId}
        </WorkbenchPill>
      ))}
      {browserSessionMode && (
        <WorkbenchPill tone="info">
          {getBrowserWorkbenchLabel(browserSessionMode)}
        </WorkbenchPill>
      )}
    </div>
  );
};

const UserNode: React.FC<{
  messageId: string;
  content: string;
  attachments?: import('@shared/contract').MessageAttachment[];
  metadata?: WorkbenchMessageMetadata;
  onRewind?: (messageId: string, content: string) => void;
  rewindDisabled?: boolean;
}> = ({ messageId, content, attachments, metadata, onRewind, rewindDisabled }) => {
  const isGuidedTurn = metadata?.runtimeInputDelivery === 'queued_next_turn';

  return (
    <div>
      <WorkbenchSummary metadata={metadata} />
      {attachments && attachments.length > 0 && (
        <div className="mb-2">
          <AttachmentDisplay attachments={attachments} />
        </div>
      )}
      {content && (
        <div className="flex justify-end">
          <div className="max-w-[86%]">
            {isGuidedTurn && (
              <div className="mb-1 flex items-center justify-end gap-2 text-xs text-zinc-400">
                <CornerDownRight className="h-3.5 w-3.5" />
                <span>已引导对话</span>
              </div>
            )}
            <div className="flex items-start gap-1.5">
              {onRewind && (
                <button
                  type="button"
                  onClick={() => onRewind(messageId, content)}
                  disabled={rewindDisabled}
                  className="mt-1 flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title={rewindDisabled ? '会话运行中，暂不能回退' : '回到这条提示词'}
                  aria-label="回到这条提示词"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              <div className="rounded-2xl px-4 py-2.5 bg-zinc-800/60 border border-white/[0.06]">
                <div className="text-zinc-200 leading-relaxed select-text">
                  <MessageContent content={content} isUser={true} />
                </div>
              </div>
            </div>
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
  isStreaming?: boolean;
  onStreamingDisplayUpdate?: (nodeId: string, displayLength: number, isAnimating: boolean) => void;
}> = ({ node, isStreaming: turnStreaming, onStreamingDisplayUpdate }) => {
  const [showReasoning, setShowReasoning] = useState(false);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const [reasoningHeight, setReasoningHeight] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasReportingStreamingDisplayRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const [selectionCopy, setSelectionCopy] = useState<SelectionCopyState | null>(null);

  const reasoningContent = sanitizeThinkingForDisplay(node.thinking || node.reasoning);
  const { displayContent, isAnimating } = useSmoothStreamingText({
    content: node.content || '',
    isStreaming: Boolean(turnStreaming),
  });

  useEffect(() => {
    if (reasoningRef.current) {
      setReasoningHeight(reasoningRef.current.scrollHeight);
    }
  }, [showReasoning, reasoningContent]);

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

  return (
    <div
      ref={rootRef}
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
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      )}

      {/* Thinking/Reasoning fold */}
      {reasoningContent?.trim() && (
        <div className="mb-2">
          <button
            type="button"
            onClick={() => setShowReasoning(!showReasoning)}
            aria-expanded={showReasoning}
            title={showReasoning ? '收起 thinking' : '展开 thinking'}
            className="flex w-full cursor-pointer items-center gap-1.5 rounded-sm py-0.5 text-left text-xs text-zinc-500 transition-colors hover:text-zinc-400"
          >
            <span className="font-mono">{showReasoning ? '▼' : '▶'}</span>
            <span>thinking</span>
          </button>
          <div
            ref={reasoningRef}
            className="overflow-hidden transition-all duration-300 ease-out"
            style={{
              maxHeight: showReasoning ? (reasoningHeight ? `${reasoningHeight}px` : '500px') : '0px',
              opacity: showReasoning ? 1 : 0,
            }}
          >
            <div className="mt-1.5 rounded-md border border-white/[0.04] bg-black/10 px-3 py-2">
              <p className="text-xs text-zinc-500 leading-5 whitespace-pre-line font-mono">
                {reasoningContent}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Text content */}
      {node.content && (
        <div ref={contentRef} className="text-zinc-200 leading-relaxed select-text">
          <MessageContent
            content={displayContent}
            isUser={false}
            isStreaming={Boolean(turnStreaming || isAnimating)}
          />
          {(turnStreaming || isAnimating) && (
            <span className="sr-only">正在生成</span>
          )}
        </div>
      )}
    </div>
  );
};

// ---- Tool Call Node ----
const ToolCallNode: React.FC<{ node: TraceNode }> = ({ node }) => {
  if (!node.toolCall) return null;

  // Reconstruct ToolCall object for ToolCallDisplay
  // 必须把语义字段（shortDescription / targetContext / expectedOutcome）一起带回来，
  // 否则 ToolCallDisplay / ToolHeader 拿不到，会 fallback 到机械路径并多渲染重复信息
  const toolCall: ToolCall = {
    id: node.toolCall.id,
    name: node.toolCall.name,
    arguments: node.toolCall.args,
    _streaming: node.toolCall._streaming,
    shortDescription: node.toolCall.shortDescription,
    targetContext: node.toolCall.targetContext,
    expectedOutcome: node.toolCall.expectedOutcome,
    result: node.toolCall.result !== undefined ? {
      toolCallId: node.toolCall.id,
      success: node.toolCall.success ?? true,
      output: node.toolCall.success !== false ? node.toolCall.result : undefined,
      error: node.toolCall.success === false ? node.toolCall.result : undefined,
      duration: node.toolCall.duration,
      outputPath: node.toolCall.outputPath,
      metadata: node.toolCall.metadata,
    } : undefined,
    liveOutput: node.toolCall.liveOutput,
  };

  return (
    <ToolCallDisplay
      toolCall={toolCall}
      index={0}
      total={1}
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

const TurnTimelineNodeRenderer: React.FC<{ node: TraceNode }> = ({ node }) => {
  if (!node.turnTimeline) return null;

  switch (node.turnTimeline.kind) {
    case 'workbench_snapshot':
      // 每条消息下的"本轮执行快照" meta 卡已从默认流里移除（噪声过重）。
      // 组件代码保留以便后续在专门视图里复用。
      return null;
    case 'capability_scope':
      // 能力范围属于右侧 TaskPanel / replay 调试信息，不再默认插入聊天主流。
      return null;
    case 'blocked_capabilities':
      return <BlockedCapabilitiesNode timeline={node.turnTimeline} />;
    case 'routing_evidence':
      return <RoutingEvidenceNode timeline={node.turnTimeline} />;
    case 'hook_activity':
      return <HookActivityNode timeline={node.turnTimeline} />;
    case 'skill_activity':
      return <SkillActivityNode timeline={node.turnTimeline} />;
    case 'artifact_ownership':
      return <ArtifactOwnershipNode timeline={node.turnTimeline} />;
    default:
      return null;
  }
};

function getTimelineContainerClass(tone: TurnTimelinePayload['tone']): string {
  switch (tone) {
    case 'success':
      return 'border-emerald-500/20 bg-emerald-500/10';
    case 'warning':
      return 'border-amber-500/20 bg-amber-500/10';
    case 'error':
      return 'border-red-500/20 bg-red-500/10';
    case 'info':
      return 'border-sky-500/20 bg-sky-500/10';
    default:
      return 'border-white/[0.06] bg-white/[0.02]';
  }
}

const BlockedCapabilitiesNode: React.FC<{ timeline: TurnTimelinePayload }> = ({ timeline }) => {
  const blocked = timeline.blockedCapabilities || [];
  if (blocked.length === 0) return null;

  return (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      <div className="mb-2 flex items-center gap-2 text-[11px] text-zinc-300">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
        <span>本轮选中的能力里有未生效项</span>
      </div>
      <div className="space-y-2">
        {blocked.map((reason) => (
          <div key={`${reason.kind}-${reason.id}`} className="rounded-md bg-black/10 px-2.5 py-2">
            <div className="mb-1 flex items-center gap-1.5">
              <WorkbenchPill tone={reason.kind === 'skill' ? 'skill' : reason.kind === 'connector' ? 'connector' : 'mcp'}>
                {reason.label}
              </WorkbenchPill>
              <span className={`text-[10px] ${reason.severity === 'error' ? 'text-red-300' : 'text-amber-300'}`}>
                {reason.code}
              </span>
            </div>
            <div className="text-xs text-zinc-200">{reason.detail}</div>
            <div className="mt-1 text-[11px] text-zinc-400">{reason.hint}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const RoutingEvidenceNode: React.FC<{ timeline: TurnTimelinePayload }> = ({ timeline }) => {
  const routing = timeline.routingEvidence;
  if (!routing) return null;

  return (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-300">
        <GitBranch className="h-3.5 w-3.5 text-cyan-300" />
        <span>Routing 证据</span>
        <WorkbenchPill tone="info">{ROUTING_LABELS[routing.mode] || routing.mode}</WorkbenchPill>
      </div>
      <div className="text-xs text-zinc-100">{routing.summary}</div>
      {routing.reason && (
        <div className="mt-1 text-[11px] text-zinc-400">{routing.reason}</div>
      )}
      <div className="mt-2 space-y-1">
        {routing.steps.map((step, index) => (
          <div key={`${routing.mode}-${index}-${step.status}`} className="flex items-start gap-2 text-[11px]">
            <span className={`mt-[2px] h-1.5 w-1.5 rounded-full ${
              step.tone === 'success'
                ? 'bg-emerald-400'
                : step.tone === 'warning'
                  ? 'bg-amber-400'
                  : step.tone === 'error'
                    ? 'bg-red-400'
                    : 'bg-sky-400'
            }`} />
            <div className="min-w-0">
              <div className="text-zinc-200">{step.label}</div>
              {step.detail && <div className="text-zinc-500">{step.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const HOOK_EVENT_LABELS: Record<string, string> = {
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  UserPromptSubmit: 'UserPromptSubmit',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  PermissionRequest: 'PermissionRequest',
  PreCompact: 'PreCompact',
  PostCompact: 'PostCompact',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
};

const HookActivityNode: React.FC<{ timeline: TurnTimelinePayload }> = ({ timeline }) => {
  const activity = timeline.hookActivity;
  const [expanded, setExpanded] = useState(false);
  if (!activity || activity.items.length === 0) return null;

  return (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      <button
        type="button"
        className="mb-1 flex w-full items-center gap-2 text-left text-[11px] text-zinc-300 transition-colors hover:text-zinc-100"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={expanded ? '收起 Hooks' : '展开 Hooks'}
      >
        <Wrench className="h-3.5 w-3.5 shrink-0 text-sky-300" />
        <span>Hooks</span>
        <span className="text-zinc-500">{activity.items.length} 次触发</span>
        {expanded ? (
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600" />
        ) : (
          <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600" />
        )}
      </button>
      <div className="text-xs text-zinc-100">{activity.summary}</div>
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {activity.items.map((item, index) => {
            const hasError = (item.errorCount || 0) > 0;
            const toneClass = item.action === 'block'
              ? 'bg-red-400'
              : hasError
                ? 'bg-amber-400'
                : item.modified
                  ? 'bg-sky-400'
                  : 'bg-emerald-400';
            return (
              <div key={`${item.event}-${item.toolName || 'event'}-${item.timestamp}-${index}`} className="flex items-start gap-2 rounded-md bg-black/10 px-2.5 py-2 text-[11px]">
                <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${toneClass}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-zinc-200">{HOOK_EVENT_LABELS[item.event] || item.event}</span>
                    {item.toolName && <WorkbenchPill tone="neutral">{item.toolName}</WorkbenchPill>}
                    <WorkbenchPill tone={item.action === 'block' ? 'info' : 'mcp'}>
                      {item.action === 'block' ? 'blocked' : 'allow'}
                    </WorkbenchPill>
                    {item.modified && <WorkbenchPill tone="info">modified</WorkbenchPill>}
                    {hasError && <WorkbenchPill tone="info">error {item.errorCount}</WorkbenchPill>}
                    <span className="text-zinc-600">{item.hookCount} hooks · {item.durationMs}ms</span>
                  </div>
                  {item.message && (
                    <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">{item.message}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

function getSkillActionLabel(action: string): string {
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

const SkillActivityNode: React.FC<{ timeline: TurnTimelinePayload }> = ({ timeline }) => {
  const activity = timeline.skillActivity;
  if (!activity || activity.items.length === 0) return null;

  return (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-300">
        <Wrench className="h-3.5 w-3.5 text-fuchsia-300" />
        <span>Skills</span>
        <span className="text-zinc-500">{activity.summary.replace(/^Skill\s*/, '')}</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {activity.items.map((item, index) => (
          <div key={`${item.skillId}-${item.action}-${index}`} className="flex items-start gap-2 rounded-md bg-black/10 px-2.5 py-2 text-[11px]">
            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-fuchsia-400" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <WorkbenchPill tone="skill">{item.label}</WorkbenchPill>
                <span className="text-zinc-300">{getSkillActionLabel(item.action)}</span>
                {item.source && <span className="text-zinc-600">{item.source}</span>}
              </div>
              {item.detail && (
                <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">{item.detail}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const ArtifactOwnershipNode: React.FC<{ timeline: TurnTimelinePayload }> = ({ timeline }) => {
  const items = (timeline.artifactOwnership || [])
    .filter((item) => !isReadOnlyArtifactOwnershipItem(item));
  if (items.length === 0) return null;

  const fileItems = items.filter((i) => i.kind === 'file');
  const nonFileItems = items.filter((i) => i.kind !== 'file');
  const hasOnlyFiles = fileItems.length > 0 && nonFileItems.length === 0;

  // 纯文件输出保持一行入口，不再额外挂"本轮输出"标题。
  // 混合/纯非文件：保留 tone 容器，维持原来的视觉层级。
  const header = (
    <div className="mb-1.5 flex items-center gap-2 text-[11px] text-zinc-400">
      <FileText className="h-3.5 w-3.5 text-emerald-300" />
      <span>Outputs</span>
    </div>
  );

  if (hasOnlyFiles) {
    return <FileArtifactCard items={fileItems} />;
  }

  return (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      {header}

      {fileItems.length > 0 && <FileArtifactCard items={fileItems} />}

      {nonFileItems.length > 0 && (
        <div className={`space-y-1.5 ${fileItems.length > 0 ? 'mt-1.5' : ''}`}>
          {nonFileItems.map((item, index) => (
            <div key={`${item.kind}-${item.label}-${index}`} className="flex items-center gap-2 rounded-md bg-black/10 px-2.5 py-2">
              <WorkbenchPill tone={item.kind === 'artifact' ? 'info' : 'neutral'}>
                {item.kind === 'artifact' ? 'Artifact' : item.kind === 'link' ? 'Link' : 'Note'}
              </WorkbenchPill>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-zinc-100">{item.label}</div>
                <div className="truncate text-[11px] text-zinc-500">{item.ownerLabel}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ---- System Node ----
const SystemNode: React.FC<{ node: TraceNode }> = ({ node }) => {
  const [expanded, setExpanded] = useState(false);

  if (node.subtype === 'compaction') {
    return (
      <div className="py-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/15 transition-colors"
        >
          <Archive className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-medium text-amber-300">上下文已压缩</span>
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-amber-400 ml-auto" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-amber-400 ml-auto" />
          )}
        </button>
        {expanded && (
          <div className="mt-2 px-3 py-2.5 rounded-md bg-amber-500/5 border border-amber-500/10">
            <ExpandableContent content={node.content} maxLines={30} />
          </div>
        )}
      </div>
    );
  }

  if (node.subtype === 'error') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
        <AlertTriangle className="w-4 h-4 text-red-400" />
        <span className="text-xs text-red-300">{node.content}</span>
      </div>
    );
  }

  if (node.subtype === 'skill_status') {
    return <SkillStatusMessage content={node.content} />;
  }

  // generic system
  return (
    <div className="px-3 py-1.5 text-xs text-zinc-500 italic">
      {node.content}
    </div>
  );
};
