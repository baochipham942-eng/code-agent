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
import { formatWorkbenchHistoryActionSummary } from '../../../utils/workbenchPresentation';
import { Archive, ChevronDown, ChevronRight, AlertTriangle, Copy, Check, FileText, FolderOpen, GitBranch, Package, Wrench } from 'lucide-react';
import { UI } from '@shared/constants';

interface TraceNodeRendererProps {
  node: TraceNode;
  /** Message attachments for user nodes */
  attachments?: import('@shared/contract').MessageAttachment[];
  /** Whether this node is in a currently streaming turn */
  isStreaming?: boolean;
}

export const TraceNodeRenderer: React.FC<TraceNodeRendererProps> = ({ node, attachments, isStreaming }) => {
  switch (node.type) {
    case 'user':
      return <UserNode content={node.content} attachments={attachments} metadata={node.metadata?.workbench} />;
    case 'assistant_text':
      return <AssistantTextNode node={node} isStreaming={isStreaming} />;
    case 'tool_call':
      return <ToolCallNode node={node} />;
    case 'system':
      return <SystemNode node={node} />;
    case 'swarm_launch_request':
      return <LaunchRequestNode node={node} />;
    case 'turn_timeline':
      return <TurnTimelineNodeRenderer node={node} />;
    default:
      return null;
  }
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

function formatSnapshotTimestamp(timestamp?: number | null): string | null {
  if (!timestamp) {
    return null;
  }

  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) {
    return null;
  }

  return value.toLocaleString();
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
  content: string;
  attachments?: import('@shared/contract').MessageAttachment[];
  metadata?: WorkbenchMessageMetadata;
}> = ({ content, attachments, metadata }) => (
  <div className="select-text">
    <WorkbenchSummary metadata={metadata} />
    {attachments && attachments.length > 0 && (
      <div className="mb-2">
        <AttachmentDisplay attachments={attachments} />
      </div>
    )}
    {content && (
      <div
        className="pl-3 border-l-2 rounded-r-lg py-2 pr-3"
        style={{
          borderColor: 'var(--cc-brand)',
          backgroundColor: 'var(--cc-user-bg)',
        }}
      >
        <div className="text-zinc-200 leading-relaxed">
          <MessageContent content={content} isUser={true} />
        </div>
      </div>
    )}
  </div>
);

// ---- Strip markdown to plain text ----
function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')           // headings
    .replace(/\*\*(.+?)\*\*/g, '$1')       // bold
    .replace(/\*(.+?)\*/g, '$1')           // italic
    .replace(/`{3}[\s\S]*?`{3}/g, (m) =>   // code blocks → keep content
      m.replace(/^`{3}.*\n?/, '').replace(/`{3}$/, ''))
    .replace(/`(.+?)`/g, '$1')             // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/^[-*+]\s+/gm, '• ')          // unordered lists
    .replace(/^\d+\.\s+/gm, '')            // ordered lists
    .replace(/^>\s+/gm, '')                // blockquotes
    .replace(/\n{3,}/g, '\n\n')            // collapse blank lines
    .trim();
}

// ---- Assistant Text Node ----
const AssistantTextNode: React.FC<{ node: TraceNode; isStreaming?: boolean }> = ({ node, isStreaming: turnStreaming }) => {
  const [showReasoning, setShowReasoning] = useState(false);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const [reasoningHeight, setReasoningHeight] = useState<number | null>(null);
  const [copied, setCopied] = useState<'markdown' | 'plain' | null>(null);
  const [hovered, setHovered] = useState(false);

  const reasoningContent = node.thinking || node.reasoning;

  useEffect(() => {
    if (reasoningRef.current) {
      setReasoningHeight(reasoningRef.current.scrollHeight);
    }
  }, [showReasoning, reasoningContent]);

  const handleCopy = useCallback(async (mode: 'markdown' | 'plain') => {
    if (!node.content) return;
    const text = mode === 'markdown' ? node.content : stripMarkdown(node.content);
    await navigator.clipboard.writeText(text);
    setCopied(mode);
    setTimeout(() => setCopied(null), UI.COPY_FEEDBACK_DURATION);
  }, [node.content]);

  return (
    <div
      className="relative group/msg"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Copy action bar - top right on hover */}
      {node.content && hovered && (
        <div className="absolute -top-1 right-0 flex items-center gap-0.5 bg-zinc-800 border border-zinc-700 rounded-md px-0.5 py-0.5 z-10 shadow-lg">
          <button
            onClick={() => handleCopy('markdown')}
            className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
            title="复制 Markdown"
          >
            {copied === 'markdown' ? <Check className="w-3 h-3 text-green-400" /> : <FileText className="w-3 h-3" />}
          </button>
          <button
            onClick={() => handleCopy('plain')}
            className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
            title="复制纯文本"
          >
            {copied === 'plain' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      )}

      {/* Thinking/Reasoning fold */}
      {reasoningContent?.trim() && (
        <div className="mb-2">
          <button
            onClick={() => setShowReasoning(!showReasoning)}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
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
            <div className="mt-1.5 pl-3 border-l border-zinc-700">
              <p className="text-xs text-zinc-500 leading-relaxed whitespace-pre-wrap font-mono">
                {reasoningContent}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Text content */}
      {node.content && (
        <div className="text-zinc-200 leading-relaxed select-text">
          <MessageContent content={node.content} isUser={false} />
          {turnStreaming && (
            <span className="inline-block w-[2px] h-[1em] bg-primary-400 align-text-bottom animate-pulse ml-0.5" />
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
  const toolCall: ToolCall = {
    id: node.toolCall.id,
    name: node.toolCall.name,
    arguments: node.toolCall.args,
    _streaming: node.toolCall._streaming,
    result: node.toolCall.result !== undefined ? {
      toolCallId: node.toolCall.id,
      success: node.toolCall.success ?? true,
      output: node.toolCall.success !== false ? node.toolCall.result : undefined,
      error: node.toolCall.success === false ? node.toolCall.result : undefined,
      duration: node.toolCall.duration,
    } : undefined,
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
      return <WorkbenchSnapshotNode timeline={node.turnTimeline} />;
    case 'capability_scope':
      return <CapabilityScopeNode timeline={node.turnTimeline} />;
    case 'blocked_capabilities':
      return <BlockedCapabilitiesNode timeline={node.turnTimeline} />;
    case 'routing_evidence':
      return <RoutingEvidenceNode timeline={node.turnTimeline} />;
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

function getCapabilityPillTone(kind: 'skill' | 'connector' | 'mcp'): 'skill' | 'connector' | 'mcp' {
  switch (kind) {
    case 'skill':
      return 'skill';
    case 'connector':
      return 'connector';
    case 'mcp':
      return 'mcp';
    default:
      return 'connector';
  }
}

const WorkbenchSnapshotNode: React.FC<{ timeline: TurnTimelinePayload }> = ({ timeline }) => {
  const snapshot = timeline.snapshot;
  if (!snapshot) return null;
  const browserSessionSnapshot = snapshot.executionIntent?.browserSessionSnapshot;
  const browserPreview = browserSessionSnapshot?.preview;
  const lastScreenshotLabel = formatSnapshotTimestamp(browserPreview?.lastScreenshotAtMs);

  return (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      <div className="mb-2 flex items-center gap-2 text-[11px] text-zinc-400">
        <Package className="h-3.5 w-3.5 text-sky-300" />
        <span>本轮执行快照</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {snapshot.workingDirectory && (
          <WorkbenchPill tone="neutral">
            <span className="inline-flex items-center gap-1">
              <FolderOpen className="h-3 w-3" />
              {snapshot.workingDirectory.split('/').filter(Boolean).pop() || snapshot.workingDirectory}
            </span>
          </WorkbenchPill>
        )}
        {snapshot.routingMode && (
          <WorkbenchPill tone="info">
            <span className="inline-flex items-center gap-1">
              <GitBranch className="h-3 w-3" />
              {ROUTING_LABELS[snapshot.routingMode] || snapshot.routingMode}
            </span>
          </WorkbenchPill>
        )}
        {(snapshot.targetAgentNames || snapshot.targetAgentIds || []).map((target) => (
          <WorkbenchPill key={target} tone="agent">@{target}</WorkbenchPill>
        ))}
        {(snapshot.selectedSkillIds || []).map((skillId) => (
          <WorkbenchPill key={`snapshot-skill-${skillId}`} tone="skill">Skill {skillId}</WorkbenchPill>
        ))}
        {(snapshot.selectedConnectorIds || []).map((connectorId) => (
          <WorkbenchPill key={`snapshot-connector-${connectorId}`} tone="connector">Connector {connectorId}</WorkbenchPill>
        ))}
        {(snapshot.selectedMcpServerIds || []).map((serverId) => (
          <WorkbenchPill key={`snapshot-mcp-${serverId}`} tone="mcp">MCP {serverId}</WorkbenchPill>
        ))}
        {snapshot.executionIntent?.browserSessionMode && (
          <WorkbenchPill tone="info">
            {getBrowserWorkbenchLabel(snapshot.executionIntent.browserSessionMode)}
          </WorkbenchPill>
        )}
        {browserSessionSnapshot && (
          <WorkbenchPill tone="info">
            {browserSessionSnapshot.ready ? 'Browser Ready' : 'Browser Blocked'}
          </WorkbenchPill>
        )}
      </div>
      {(browserPreview?.title || browserPreview?.url || browserPreview?.frontmostApp || lastScreenshotLabel || browserSessionSnapshot?.blockedDetail) && (
        <div className="mt-2 space-y-1 text-[11px] text-zinc-400">
          {(browserPreview?.title || browserPreview?.url) && (
            <div className="truncate">
              Browser 预览：{browserPreview?.title || '无标题'}{browserPreview?.url ? ` · ${browserPreview.url}` : ''}
            </div>
          )}
          {browserPreview?.frontmostApp && (
            <div className="truncate">Frontmost App：{browserPreview.frontmostApp}</div>
          )}
          {lastScreenshotLabel && (
            <div>最近截图：{lastScreenshotLabel}</div>
          )}
          {browserSessionSnapshot?.blockedDetail && (
            <div className="text-amber-200">未就绪：{browserSessionSnapshot.blockedDetail}</div>
          )}
          {browserSessionSnapshot?.blockedHint && (
            <div>{browserSessionSnapshot.blockedHint}</div>
          )}
        </div>
      )}
    </div>
  );
};

const CapabilityScopeSection: React.FC<{
  label: string;
  emptyLabel: string;
  hasContent: boolean;
  children: React.ReactNode;
}> = ({ label, emptyLabel, hasContent, children }) => {
  return (
    <div className="rounded-md bg-black/10 px-2.5 py-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      {hasContent ? (
        children
      ) : (
        <div className="text-[11px] text-zinc-600">{emptyLabel}</div>
      )}
    </div>
  );
};

const CapabilityScopeNode: React.FC<{ timeline: TurnTimelinePayload }> = ({ timeline }) => {
  const scope = timeline.capabilityScope;
  if (!scope) return null;

  return (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      <div className="mb-2 flex items-center gap-2 text-[11px] text-zinc-300">
        <Wrench className="h-3.5 w-3.5 text-amber-300" />
        <span>Scope Inspector Lite</span>
        <span className="text-zinc-500">
          已选 {scope.selected.length} · 放行 {scope.allowed.length} · 阻塞 {scope.blocked.length} · 调用 {scope.invoked.length}
        </span>
      </div>

      <div className="space-y-2">
        <CapabilityScopeSection
          label="User Selected"
          emptyLabel="本轮没有显式选择 capability。"
          hasContent={scope.selected.length > 0}
        >
          <div className="flex flex-wrap gap-1.5">
            {scope.selected.map((item) => (
              <WorkbenchPill key={`selected-${item.kind}-${item.id}`} tone={getCapabilityPillTone(item.kind)}>
                {item.label}
              </WorkbenchPill>
            ))}
          </div>
        </CapabilityScopeSection>

        <CapabilityScopeSection
          label="Runtime Allowed"
          emptyLabel="当前没有被 runtime 放行的已选 capability。"
          hasContent={scope.allowed.length > 0}
        >
          <div className="flex flex-wrap gap-1.5">
            {scope.allowed.map((item) => (
              <WorkbenchPill key={`allowed-${item.kind}-${item.id}`} tone={getCapabilityPillTone(item.kind)}>
                {item.label}
              </WorkbenchPill>
            ))}
          </div>
        </CapabilityScopeSection>

        <CapabilityScopeSection
          label="Runtime Blocked"
          emptyLabel="当前没有 runtime blocked capability。"
          hasContent={scope.blocked.length > 0}
        >
          <div className="space-y-2">
            {scope.blocked.map((reason) => (
              <div key={`blocked-${reason.kind}-${reason.id}`} className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                <div className="mb-1 flex items-center gap-1.5">
                  <WorkbenchPill tone={getCapabilityPillTone(reason.kind)}>
                    {reason.label}
                  </WorkbenchPill>
                  <span className={`text-[10px] ${reason.severity === 'error' ? 'text-red-300' : 'text-amber-300'}`}>
                    {reason.code}
                  </span>
                </div>
                <div className="text-xs text-zinc-200">{reason.detail}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{reason.hint}</div>
              </div>
            ))}
          </div>
        </CapabilityScopeSection>

        <CapabilityScopeSection
          label="Actually Invoked"
          emptyLabel="本轮还没有 tool call 命中这些 capability。"
          hasContent={scope.invoked.length > 0}
        >
          <div className="space-y-1.5">
            {scope.invoked.map((item) => {
              const actionSummary = formatWorkbenchHistoryActionSummary(item.topActions, { maxActions: 2 });
              return (
                <div key={`invoked-${item.kind}-${item.id}`} className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                  <WorkbenchPill tone={getCapabilityPillTone(item.kind)}>
                    {item.label}
                  </WorkbenchPill>
                  <div className="min-w-0 flex-1 text-[11px] text-zinc-400">
                    {actionSummary || 'invoked'}
                  </div>
                  <div className="text-[10px] text-zinc-600">{item.count}x</div>
                </div>
              );
            })}
          </div>
        </CapabilityScopeSection>
      </div>
    </div>
  );
};

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

const ArtifactOwnershipNode: React.FC<{ timeline: TurnTimelinePayload }> = ({ timeline }) => {
  const items = timeline.artifactOwnership || [];
  if (items.length === 0) return null;

  const fileItems = items.filter((i) => i.kind === 'file');
  const nonFileItems = items.filter((i) => i.kind !== 'file');
  const hasOnlyFiles = fileItems.length > 0 && nonFileItems.length === 0;

  // 纯文件：FileArtifactCard 自身已带卡片样式，外层不再套 border，避免"卡中卡"。
  // 混合/纯非文件：保留 tone 容器，维持原来的视觉层级。
  const header = (
    <div className="mb-1.5 flex items-center gap-2 text-[11px] text-zinc-400">
      <FileText className="h-3.5 w-3.5 text-emerald-300" />
      <span>本轮输出</span>
    </div>
  );

  if (hasOnlyFiles) {
    return (
      <div>
        {header}
        <FileArtifactCard items={fileItems} />
      </div>
    );
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

  // skill_status or generic system
  return (
    <div className="px-3 py-1.5 text-xs text-zinc-500 italic">
      {node.content}
    </div>
  );
};
