// ============================================================================
// TraceTimelineNodes - turn_timeline 节点的子渲染器（从 TraceNodeRenderer 抽出，
// 逐行搬移，无 JSX/逻辑改动）：BlockedCapabilities / RoutingEvidence / HookActivity /
// SkillActivity / ArtifactOwnership 五类时间线卡 + 分发器 TurnTimelineNodeRenderer。
// ============================================================================

import React, { useState } from 'react';
import type { TraceNode } from '@shared/contract/trace';
import type { TurnTimelineNode as TurnTimelinePayload, TurnTimelineTone } from '@shared/contract/turnTimeline';
import type { FileChange } from '../../../utils/turnDiffSummary';
import { FileArtifactCard } from './MessageBubble/FileArtifactCard';
import { WorkbenchPill } from '../../workbench/WorkbenchPrimitives';
import { isReadOnlyArtifactOwnershipItem } from '../../../utils/artifactOwnership';
import { kindForTurnArtifact } from '../../../utils/deliverables';
import { iconForKind } from './MessageBubble/DeliverableCardList';
import { ReceiptRows } from '../../ReceiptRows';
import { useI18n } from '../../../hooks/useI18n';
import { getHumanToolLabel } from '../../../utils/toolHumanLabel';
import { AlertTriangle, ChevronDown, ChevronRight, FileText, Link, Send, Wrench } from 'lucide-react';

export const TurnTimelineNodeRenderer: React.FC<{
  node: TraceNode;
  sessionId?: string;
  isStreaming?: boolean;
  fileChangesByPath?: ReadonlyMap<string, FileChange>;
}> = ({ node, sessionId, isStreaming, fileChangesByPath }) => {
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
      // Auto 未命中专用 agent 后回落 default 是系统正常路径，不在聊天主流告警。
      // 节点本身仍保留：产物归属、runWorkbench/日志投影继续从它取原始证据。
      if (node.turnTimeline.routingEvidence?.autoFallbackToDefault) return null;
      return node.turnTimeline.tone === 'warning' || node.turnTimeline.tone === 'error'
        ? <RoutingEvidenceNode timeline={node.turnTimeline} />
        : null;
    case 'hook_activity':
      return <HookActivityNode timeline={node.turnTimeline} />;
    case 'skill_activity':
      return <SkillActivityNode timeline={node.turnTimeline} />;
    case 'artifact_ownership':
      return (
        <ArtifactOwnershipNode
          timeline={node.turnTimeline}
          sessionId={sessionId}
          isStreaming={isStreaming}
          fileChangesByPath={fileChangesByPath}
        />
      );
    default:
      return null;
  }
};

function getTimelineContainerClass(tone: TurnTimelinePayload['tone']): string {
  switch (tone) {
    case 'success':
      return 'border-badge-success/20 bg-emerald-500/10';
    case 'warning':
      return 'border-badge-warning/20 bg-amber-500/10';
    case 'error':
      return 'border-red-500/20 bg-red-500/10';
    case 'info':
      return 'border-badge-info/20 bg-sky-500/10';
    default:
      return 'border-border-muted bg-surface-subtle';
  }
}

const BlockedCapabilitiesNode: React.FC<{ timeline: TurnTimelinePayload }> = ({ timeline }) => {
  const blocked = timeline.blockedCapabilities || [];
  if (blocked.length === 0) return null;

  return (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      <div className="mb-2 flex items-center gap-2 text-[11px] text-zinc-300">
        <AlertTriangle className="h-3.5 w-3.5 text-badge-warning" />
        <span>本轮选中的能力里有未生效项</span>
      </div>
      <div className="space-y-2">
        {blocked.map((reason) => (
          <div key={`${reason.kind}-${reason.id}`} className="rounded-md bg-black/10 px-2.5 py-2">
            <div className="mb-1 flex items-center gap-1.5">
              <WorkbenchPill tone={reason.kind === 'skill' ? 'skill' : reason.kind === 'connector' ? 'connector' : 'mcp'}>
                {reason.label}
              </WorkbenchPill>
              <span className={`text-[10px] ${reason.severity === 'error' ? 'text-badge-danger' : 'text-badge-warning'}`}>
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

const ROUTING_STEP_DOT_CLASSES: Record<TurnTimelineTone, string> = {
  error: 'bg-mark-danger',
  warning: 'bg-mark-warning',
  success: 'bg-mark-success',
  info: 'bg-mark-info',
  neutral: 'bg-mark-neutral',
};

const RoutingEvidenceNode: React.FC<{ timeline: TurnTimelinePayload }> = ({ timeline }) => {
  const { t } = useI18n();
  const labels = t.turnRouting;
  const evidence = timeline.routingEvidence;
  if (!evidence) return null;

  const modeLabel = evidence.mode === 'auto'
    ? labels.modeAuto
    : evidence.mode === 'direct'
      ? labels.modeDirect
      : labels.modeParallel;
  const stepStatusLabels: Record<string, string> = {
    requested: labels.statusRequested,
    delivered: labels.statusDelivered,
    missing: labels.statusMissing,
    resolved: labels.statusResolved,
    approved: labels.statusApproved,
    rejected: labels.statusRejected,
    started: labels.statusStarted,
    fallback: labels.statusFallback,
  };

  return (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-300">
        <AlertTriangle className={`h-3.5 w-3.5 ${timeline.tone === 'error' ? 'text-badge-danger' : 'text-badge-warning'}`} />
        <span>{labels.title}</span>
        <WorkbenchPill tone="neutral">{modeLabel}</WorkbenchPill>
        {(evidence.agentNames || []).map((name) => (
          <WorkbenchPill key={name} tone="agent">{name}</WorkbenchPill>
        ))}
      </div>
      <div className="text-xs text-zinc-100">{evidence.summary}</div>
      {evidence.steps.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {evidence.steps.map((step, index) => (
            <div key={`${step.status}-${step.label}-${index}`} className="flex items-start gap-2 rounded-md bg-black/10 px-2.5 py-2 text-[11px]">
              <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${ROUTING_STEP_DOT_CLASSES[step.tone] || ROUTING_STEP_DOT_CLASSES.neutral}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {/* 异常步骤（warning/error）用红/琥珀色文案，一眼看出是哪一步挂的 */}
                  <span className={step.tone === 'error' ? 'text-badge-danger' : step.tone === 'warning' ? 'text-badge-warning' : 'text-zinc-200'}>
                    {step.label}
                  </span>
                  <WorkbenchPill tone={step.tone === 'error' || step.tone === 'warning' ? 'info' : 'neutral'}>
                    {stepStatusLabels[step.status] || step.status}
                  </WorkbenchPill>
                </div>
                {step.detail && (
                  <div className="mt-1 text-zinc-600">{step.detail}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
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
  const { t } = useI18n();
  const labels = t.turnHooks;
  const activity = timeline.hookActivity;
  const [expanded, setExpanded] = useState(false);
  if (!activity || activity.items.length === 0) return null;

  const sourceLabel = (sources: Array<'global' | 'project'>): string => sources
    .map((source) => (source === 'global' ? labels.sourceGlobal : labels.sourceProject))
    .join('、');

  return (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      <button
        type="button"
        className="mb-1 flex w-full items-center gap-2 text-left text-[11px] text-zinc-300 transition-colors hover:text-zinc-100"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={expanded ? labels.collapse : labels.expand}
      >
        <Wrench className="h-3.5 w-3.5 shrink-0 text-badge-info" />
        <span>{labels.title}</span>
        {expanded ? (
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600" />
        ) : (
          <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600" />
        )}
      </button>
      <div className="text-xs text-zinc-100">{activity.summary}</div>
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {activity.items.map((item, index) => (
            <div key={`${item.event}-${item.toolName || 'event'}-${item.timestamp}-${index}`} className="flex items-start gap-2 rounded-md bg-black/10 px-2.5 py-2 text-[11px]">
              <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${
                // 与 TurnCard 同一套语义：拦下是 hook 的正常决策（amber），只有执行出错才红
                item.action === 'block' ? 'bg-mark-warning' : (item.errorCount || 0) > 0 ? 'bg-mark-danger' : 'bg-mark-success'
              }`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-zinc-200">{(item.names || []).join('、') || labels.unnamed}</span>
                  <WorkbenchPill tone="neutral">{HOOK_EVENT_LABELS[item.event] || item.event}</WorkbenchPill>
                  {item.toolName && <WorkbenchPill tone="neutral">{item.toolName}</WorkbenchPill>}
                  <WorkbenchPill tone={item.action === 'block' ? 'info' : 'mcp'}>
                    {item.action === 'block' ? labels.blocked : labels.allowed}
                  </WorkbenchPill>
                  {(item.errorCount || 0) > 0 && (
                    <WorkbenchPill tone="info">{labels.errored.replace('{count}', String(item.errorCount))}</WorkbenchPill>
                  )}
                </div>
                {/* 刻意到此为止：hook 的输出内容不上屏（契约层已无该字段），要看去日志。 */}
                <div className="mt-1 text-zinc-600">{sourceLabel(item.sources)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function getSkillActionLabel(action: string): string {
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

const SkillActivityNode: React.FC<{ timeline: TurnTimelinePayload }> = ({ timeline }) => {
  const { t } = useI18n();
  const activity = timeline.skillActivity;
  if (!activity || activity.items.length === 0) return null;

  return (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-300">
        <Wrench className="h-3.5 w-3.5 text-badge-accent" />
        <span>{t.turnSections.skills}</span>
        <span className="text-zinc-500">{activity.summary.replace(/^Skill\s*/, '')}</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {activity.items.map((item, index) => (
          <div key={`${item.skillId}-${item.action}-${index}`} className="flex items-start gap-2 rounded-md bg-black/10 px-2.5 py-2 text-[11px]">
            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-mark-accent" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <WorkbenchPill tone="skill">{item.label}</WorkbenchPill>
                <span className="text-zinc-300">{getSkillActionLabel(item.action)}</span>
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

type ArtifactItem = NonNullable<TurnTimelinePayload['artifactOwnership']>[number];

const ArtifactItemPills: React.FC<{ items: ArtifactItem[]; className?: string }> = ({ items, className }) => {
  const { t } = useI18n();
  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      {items.map((item, index) => (
        <div key={`${item.kind}-${item.label}-${index}`} className="flex items-center gap-2 rounded-md bg-black/10 px-2.5 py-2">
          {item.kind === 'link' ? (
            // link 项在折叠的「来源」区里，Link 徽章 + 来源工具名次行对溯源场景是对的，保持现状。
            <WorkbenchPill tone="neutral">Link</WorkbenchPill>
          ) : (
            // 非 link 项：按扩展名的文件类型图标替掉 Artifact/Note 徽章——产物卡里
            // 文档/表格/演示稿必须一眼可辨，「Artifact」对非程序员用户零意义。
            iconForKind(kindForTurnArtifact(item))
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-zinc-100">{item.label}</div>
            {/* 非 link 项的 ownerLabel 恒为「Assistant」类零信息文案，不渲染次行；
                link 项的次行是抓取来源（WebFetch 等），有信息量，保留。 */}
            {item.kind === 'link' && (
              <div className="truncate text-[11px] text-zinc-500">
                {getHumanToolLabel({
                  toolName: item.ownerLabel,
                  labels: t.receiptPresentation.humanToolLabels,
                })}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

const ArtifactOwnershipNode: React.FC<{
  timeline: TurnTimelinePayload;
  sessionId?: string;
  isStreaming?: boolean;
  fileChangesByPath?: ReadonlyMap<string, FileChange>;
}> = ({ timeline, sessionId, isStreaming, fileChangesByPath }) => {
  const { t } = useI18n();
  // Sources（溯源来源）默认折叠：保留可信/溯源能力但不扰民（产品决策，林晨 2026-06-29）。
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // 写回外部世界不可逆，「已执行」默认展开，与只读来源分开处理。
  const [receiptsOpen, setReceiptsOpen] = useState(true);
  const items = (timeline.artifactOwnership || [])
    .filter((item) => !isReadOnlyArtifactOwnershipItem(item));
  if (items.length === 0) return null;

  // 分流判据 = 角色轴（2026-08-07）：material（来源、检索结果、读取内容）降级进安静的
  // 「来源」区，deliverable 才进产物绿卡。以前按 kind === 'link' 判，只接住了 WebFetch
  // 的链接，memoryWrite 写的记忆文件这类 material 会漏进产物卡。
  const materialItems = items.filter((i) => i.role === 'material');
  const receiptItems = items.filter((i) => i.role === 'receipt');
  const outputItems = items.filter((i) => i.role === 'deliverable');
  const fileItems = outputItems.filter((i) => i.kind === 'file');
  const nonFileOutputItems = outputItems.filter((i) => i.kind !== 'file'); // artifact / note
  const hasMaterials = materialItems.length > 0;

  const turnId = timeline.id.endsWith('-artifact-ownership')
    ? timeline.id.slice(0, -'-artifact-ownership'.length)
    : undefined;
  const mediaContext = sessionId || turnId
    ? { sessionId, turnId }
    : undefined;

  // 纯文件、且无来源：保持原来的一行入口（无标题/无强调边框）。
  if (outputItems.length > 0 && nonFileOutputItems.length === 0 && !hasMaterials && receiptItems.length === 0) {
    return <FileArtifactCard items={fileItems} mediaContext={mediaContext} fileChangesByPath={fileChangesByPath} />;
  }

  const outputsCard = outputItems.length > 0 ? (
    <div className={`rounded-lg border px-3 py-2 ${getTimelineContainerClass(timeline.tone)}`}>
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-zinc-400">
        <FileText className="h-3.5 w-3.5 text-badge-success" />
        <span>{t.turnSections.outputs}</span>
      </div>
      {fileItems.length > 0 && (
        <FileArtifactCard items={fileItems} mediaContext={mediaContext} fileChangesByPath={fileChangesByPath} />
      )}
      {nonFileOutputItems.length > 0 && (
        <ArtifactItemPills items={nonFileOutputItems} className={fileItems.length > 0 ? 'mt-1.5' : ''} />
      )}
    </div>
  ) : null;

  const sourcesBlock = hasMaterials ? (
    <div className={`rounded-lg border px-3 py-2 border-border-muted bg-surface-subtle ${outputsCard ? 'mt-1.5' : ''}`}>
      <button
        type="button"
        onClick={() => setSourcesOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-[11px] text-zinc-400 hover:text-zinc-300 transition-colors"
      >
        {sourcesOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Link className="h-3.5 w-3.5 text-zinc-400" />
        <span>{t.turnSections.sources}</span>
        <span className="text-zinc-500">({materialItems.length})</span>
      </button>
      {sourcesOpen && <ArtifactItemPills items={materialItems} className="mt-1.5" />}
    </div>
  ) : null;

  const receiptsBlock = receiptItems.length > 0 && !isStreaming ? (
    <div className={`rounded-lg border border-badge-success/30 bg-emerald-500/[0.035] px-3 py-2 ${
      outputsCard || sourcesBlock ? 'mt-1.5' : ''
    }`}>
      <button /* ds-allow:button: 与同级「来源」折叠头同款，走 Button primitive 会带出不一致的内边距与变体样式 */
        type="button"
        onClick={() => setReceiptsOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-[11px] text-zinc-300 transition-colors hover:text-zinc-100"
        data-testid="turn-receipts-toggle"
      >
        {receiptsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Send className="h-3.5 w-3.5 text-badge-success" />
        <span>{t.turnSections.executed}</span>
        <span className="text-zinc-500">({receiptItems.length})</span>
      </button>
      {receiptsOpen && (
        <div className="mt-1.5" data-testid="turn-receipts-list">
          <ReceiptRows items={receiptItems.map((item, index) => ({
            id: item.artifactId || `${item.sourceNodeId || timeline.id}:${item.label}:${index}`,
            status: item.receipt?.status || 'succeeded',
            summary: item.receipt?.summary || item.label,
            detail: item.receipt?.detail,
            sourceTool: item.receipt?.sourceTool || item.ownerLabel,
            connector: item.receipt?.connector,
            recipient: item.receipt?.recipient,
            createdAt: timeline.timestamp,
          }))} />
        </div>
      )}
    </div>
  ) : null;

  return (
    <>
      {outputsCard}
      {sourcesBlock}
      {receiptsBlock}
    </>
  );
};
