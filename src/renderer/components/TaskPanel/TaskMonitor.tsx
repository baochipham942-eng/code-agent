// ============================================================================
// TaskMonitor - StatusRail 主工作面视图
// ============================================================================
// 主卡片链路: 任务 → 待审 → 产物 → 上下文 → MCP
// 数据统一来自 useStatusRailModel
// ============================================================================

import React, { useMemo, useCallback, useState } from 'react';
import type {
  BlockedCapabilityReason,
  TurnCapabilityInvocationItem,
  TurnCapabilityScopeItem,
  TurnRoutingEvidenceStep,
} from '@shared/contract/turnTimeline';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { useStatusRailModel, type StatusRailContextModel } from '../../hooks/useStatusRailModel';
import { useRunWorkbenchModel } from '../../hooks/useRunWorkbenchModel';
import { useCurrentTurnArtifactOwnership } from '../../hooks/useCurrentTurnArtifactOwnership';
import { useCurrentTurnCapabilityScope } from '../../hooks/useCurrentTurnCapabilityScope';
import { useCurrentTurnRoutingEvidence } from '../../hooks/useCurrentTurnRoutingEvidence';
import { useWorkspacePreviewModel } from '../../hooks/useWorkspacePreviewModel';
import { useWorkbenchCapabilityQuickActionRunner } from '../../hooks/useWorkbenchCapabilityQuickActionRunner';
import { useWorkbenchInsights } from '../../hooks/useWorkbenchInsights';
import {
  Loader2, AlertTriangle,
  Wrench, GitBranch,
} from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { formatElapsed } from './taskPanelUtils';
import { useToolProgress } from './useToolProgress';
import { ApprovalSyncCard } from './ApprovalSyncCard';
import { Card, CardEmptyState as EmptyState } from './Card';
import { HandoffCard } from './HandoffCard';
import {
  CurrentTurnArtifactOwnershipCard,
  OutputFileRows,
} from './OutputArtifactRows';
import {
  TaskDashboardSummary,
} from './RunWorkbenchCards';
import { WorkbenchCapabilityDetailButton, WorkbenchReferenceRow } from './WorkbenchPrimitives';
import { WorkbenchPill } from '../workbench/WorkbenchPrimitives';
import { WorkbenchCapabilitySheetLite } from '../workbench/WorkbenchCapabilitySheetLite';
import { formatWorkbenchHistoryActionSummary } from '../../utils/workbenchPresentation';
import {
  getWorkbenchCapabilityQuickActions,
  getWorkbenchCapabilityQuickActionFeedback,
  type WorkbenchQuickAction,
} from '../../utils/workbenchQuickActions';
import type { WorkbenchCapabilityRegistryItem } from '../../utils/workbenchCapabilityRegistry';
import {
  findWorkbenchCapabilityHistoryItem,
  resolveWorkbenchCapabilityFromSources,
  type WorkbenchCapabilityTarget,
} from '../../utils/workbenchCapabilitySheet';

export const TaskMonitor: React.FC = () => {
  const { currentSessionId } = useSessionStore();
  const { workingDirectory } = useAppStore();
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore((state) => state.pendingPermissionSessionId);
  const queuedPermissionRequests = useAppStore((state) => state.queuedPermissionRequests);
  const openWorkspacePreview = useAppStore((state) => state.openWorkspacePreview);
  const { references: referencedWorkbenchItems, history: workbenchHistory } = useWorkbenchInsights();
  const currentTurnArtifactOwnership = useCurrentTurnArtifactOwnership();
  const currentTurnCapabilityScope = useCurrentTurnCapabilityScope();
  const currentTurnRoutingEvidence = useCurrentTurnRoutingEvidence();
  const workspacePreviewItems = useWorkspacePreviewModel();
  const { runningActionKey, actionErrors, completedActions, runQuickAction } = useWorkbenchCapabilityQuickActionRunner();
  const { t } = useI18n();
  const { toolTimeout } = useToolProgress(currentSessionId);

  const model = useStatusRailModel();
  const runWorkbench = useRunWorkbenchModel();
  const { context, outputs } = model;
  const blockedScopeCount = currentTurnCapabilityScope?.scope.blocked?.length ?? 0;
  const mcpNeedsAttention = blockedScopeCount > 0
    || currentTurnRoutingEvidence?.tone === 'warning'
    || currentTurnRoutingEvidence?.tone === 'error';
  const loopFileItems = useMemo(() => getUniqueFileContextItems(context), [context]);

  const [activeSheetEntry, setActiveSheetEntry] = useState<{
    target: WorkbenchCapabilityTarget;
    blockedReason?: BlockedCapabilityReason | null;
  } | null>(null);

  const blockedCapabilitiesWithActions = useMemo(() => (
    currentTurnCapabilityScope?.blockedCapabilities
      .map((capability) => ({
        capability,
        actions: getWorkbenchCapabilityQuickActions(capability),
      }))
      .filter(({ actions }) => actions.length > 0)
      ?? []
  ), [currentTurnCapabilityScope]);
  const activeSheetCapability = useMemo(
    () => resolveWorkbenchCapabilityFromSources({
      target: activeSheetEntry?.target ?? null,
      primaryItems: currentTurnCapabilityScope?.selectedCapabilities || [],
      references: referencedWorkbenchItems,
    }),
    [activeSheetEntry, currentTurnCapabilityScope, referencedWorkbenchItems],
  );
  const activeSheetHistory = useMemo(
    () => activeSheetEntry ? findWorkbenchCapabilityHistoryItem(workbenchHistory, activeSheetEntry.target) : null,
    [activeSheetEntry, workbenchHistory],
  );
  const openCapabilitySheet = useCallback((
    target: WorkbenchCapabilityTarget,
    blockedReason?: BlockedCapabilityReason | null,
  ) => {
    setActiveSheetEntry({
      target,
      blockedReason: blockedReason || null,
    });
  }, []);
  const openPreviewWorkspace = useCallback((itemId?: string | null) => {
    openWorkspacePreview(itemId ?? workspacePreviewItems[0]?.id ?? null);
  }, [openWorkspacePreview, workspacePreviewItems]);
  const visiblePendingApproval = Boolean(
    pendingPermissionRequest
    && (!pendingPermissionSessionId || !currentSessionId || pendingPermissionSessionId === currentSessionId),
  );
  const approvalQueues = queuedPermissionRequests || {};
  const approvalQueueCount = (currentSessionId ? approvalQueues[currentSessionId]?.length ?? 0 : 0)
    + (approvalQueues.global?.length ?? 0);
  const approvalCount = (visiblePendingApproval ? 1 : 0) + approvalQueueCount;
  const sourceHasActionFeedback = Boolean(currentTurnCapabilityScope) && (
    Boolean(runningActionKey)
    || Object.keys(actionErrors).length > 0
    || Object.keys(completedActions).length > 0
  );
  const mcpCount = referencedWorkbenchItems.length
    + (currentTurnCapabilityScope ? currentTurnCapabilityScope.scope.selected.length : 0);
  const shouldShowMcpCard = mcpCount > 0 || mcpNeedsAttention || sourceHasActionFeedback;
  const shouldShowCapabilityScope = Boolean(currentTurnCapabilityScope)
    && (mcpNeedsAttention || sourceHasActionFeedback);
  const shouldShowRoutingEvidence = Boolean(currentTurnRoutingEvidence)
    && (currentTurnRoutingEvidence?.tone === 'warning' || currentTurnRoutingEvidence?.tone === 'error');
  const mcpDefaultExpanded = mcpNeedsAttention || sourceHasActionFeedback;
  const loopFilesDefaultExpanded = loopFileItems.length > 0 || runWorkbench.run.status !== 'completed';

  // ── 渲染 ──

  return (
    <div className="space-y-2">
      {/* 超时警告 */}
      {toolTimeout && (
        <div className="flex items-center gap-2 text-xs text-amber-400/80 py-1">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{toolTimeout.toolName} {formatElapsed(toolTimeout.elapsedMs)}</span>
        </div>
      )}

      <Card
        title="任务"
        storageKey="task"
        count={runWorkbench.tasks.length > 0 ? String(runWorkbench.tasks.length) : undefined}
        highlight={runWorkbench.run.status === 'blocked' || runWorkbench.run.status === 'waiting_approval'}
      >
        <TaskDashboardSummary tasks={runWorkbench.tasks} run={runWorkbench.run} />
      </Card>

      {approvalCount > 0 && (
        <Card
          title="待审"
          storageKey="approvals"
          count={String(approvalCount)}
          highlight={visiblePendingApproval}
        >
          <ApprovalSyncCard />
        </Card>
      )}

      <HandoffCard />

      {(currentTurnArtifactOwnership || outputs.count > 0) && (
        <Card
          title={t.taskPanel.sectionOutputs}
          storageKey="outputs"
          count={currentTurnArtifactOwnership
            ? String(currentTurnArtifactOwnership.artifactOwnership.length)
            : String(outputs.count)}
          highlight={currentTurnArtifactOwnership?.tone === 'warning' || currentTurnArtifactOwnership?.tone === 'error'}
        >
          {currentTurnArtifactOwnership ? (
            <CurrentTurnArtifactOwnershipCard
              artifactOwnership={currentTurnArtifactOwnership.artifactOwnership}
              previewItems={workspacePreviewItems}
              workingDirectory={workingDirectory}
              onOpenPreview={openPreviewWorkspace}
            />
          ) : (
            <OutputFileRows
              files={outputs.files}
              previewItems={workspacePreviewItems}
              onOpenPreview={openPreviewWorkspace}
            />
          )}
        </Card>
      )}

      {loopFileItems.length > 0 && (
        <Card
          title="上下文"
          storageKey="loop-files"
          count={String(loopFileItems.length)}
          defaultExpanded={loopFilesDefaultExpanded}
        >
          <LoopFilesSummary items={loopFileItems} />
        </Card>
      )}

      {shouldShowMcpCard && (
        <Card
          title="MCP"
          storageKey="mcp"
          count={mcpCount > 0 ? String(mcpCount) : undefined}
          defaultExpanded={mcpDefaultExpanded}
          highlight={mcpNeedsAttention}
        >
          <div className="space-y-2">
            {shouldShowCapabilityScope && currentTurnCapabilityScope && (
              <SourceSubsection
                title="当前能力"
                count={`#${currentTurnCapabilityScope.turnNumber}`}
                highlight={blockedScopeCount > 0}
              >
                <CurrentTurnCapabilityScopeCard
                  scopeView={currentTurnCapabilityScope}
                  blockedCapabilitiesWithActions={blockedCapabilitiesWithActions}
                  runningActionKey={runningActionKey}
                  actionErrors={actionErrors}
                  completedActions={completedActions}
                  onQuickAction={runQuickAction}
                  onOpenCapability={openCapabilitySheet}
                />
              </SourceSubsection>
            )}

            {shouldShowRoutingEvidence && currentTurnRoutingEvidence && (
              <SourceSubsection
                title="路由异常"
                count={`#${currentTurnRoutingEvidence.turnNumber}`}
                highlight
              >
                <CurrentTurnRoutingEvidenceCard routingView={currentTurnRoutingEvidence} />
              </SourceSubsection>
            )}

            <SourceSubsection
              title={t.taskPanel.sectionReferences}
              count={referencedWorkbenchItems.length > 0 ? String(referencedWorkbenchItems.length) : '0'}
            >
              {referencedWorkbenchItems.length > 0 ? (
                <div className="space-y-0.5">
                  {referencedWorkbenchItems.map((reference) => (
                    <WorkbenchReferenceRow
                      key={`${reference.kind}-${reference.id}`}
                      reference={reference}
                      locale="zh"
                      onOpenDetails={() => openCapabilitySheet({
                        kind: reference.kind,
                        id: reference.id,
                      })}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState text={t.taskPanel.skillsMcpEmpty} />
              )}
            </SourceSubsection>
          </div>
        </Card>
      )}

      <WorkbenchCapabilitySheetLite
        isOpen={Boolean(activeSheetCapability)}
        capability={activeSheetCapability}
        historyItem={activeSheetHistory}
        blockedReason={activeSheetEntry?.blockedReason || null}
        runningActionKey={runningActionKey}
        actionError={activeSheetCapability ? actionErrors[activeSheetCapability.key] : null}
        completedAction={activeSheetCapability ? completedActions[activeSheetCapability.key] : null}
        onQuickAction={runQuickAction}
        onClose={() => setActiveSheetEntry(null)}
      />

    </div>
  );
};

type LoopFileItem = StatusRailContextModel['items'][number];

function getUniqueFileContextItems(context: StatusRailContextModel): LoopFileItem[] {
  // counter 与 list 必须用同一来源（context.items 已去重），避免显示「文件 5」但下方只列 2 条的不一致。
  // 进一步按路径合并：同一文件被 Read+Write 多次只算 1 个，detail 合并成 "Read / Write"。
  const seen = new Map<string, LoopFileItem>();
  for (const item of context.items || []) {
    if (item.bucket !== 'files') continue;
    const key = item.path || item.label;
    const existing = seen.get(key);
    if (existing) {
      if (item.detail) {
        const parts = existing.detail ? existing.detail.split(' / ') : [];
        if (!parts.includes(item.detail)) {
          existing.detail = parts.length > 0 ? `${existing.detail} / ${item.detail}` : item.detail;
        }
      }
    } else {
      seen.set(key, { ...item });
    }
  }
  return Array.from(seen.values());
}

function LoopFilesSummary({ items }: { items: LoopFileItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? items.slice(0, 20) : items.slice(0, 6);

  return (
    <div className="rounded-md border border-white/[0.06] bg-black/10 px-2.5 py-2">
      <div className="mb-2 text-[10px] text-zinc-500">
        最近进入对话链路的文件
      </div>
      <div className="space-y-0.5">
        {visibleItems.map((item) => (
          <div
            key={item.path || item.id}
            className="flex items-center gap-2 truncate text-[10px] text-zinc-500"
            title={item.path || item.label}
          >
            <span className="h-1 w-1 flex-shrink-0 rounded-full bg-zinc-600" />
            <span className="truncate">{item.label}</span>
            {item.detail && (
              <span className="flex-shrink-0 text-zinc-700">{item.detail}</span>
            )}
          </div>
        ))}
      </div>
      {items.length > 6 && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-2 text-[10px] text-zinc-500 transition-colors hover:text-zinc-300"
        >
          {expanded ? '收起' : `展开 ${Math.min(items.length, 20)} 个`}
          {items.length > 20 && !expanded ? `，另有 ${items.length - 20} 个` : ''}
        </button>
      )}
      {expanded && items.length > 20 && (
        <div className="mt-1 text-[10px] text-zinc-700">
          还有 {items.length - 20} 个文件未显示
        </div>
      )}
    </div>
  );
}

function SourceSubsection({
  title,
  count,
  highlight,
  children,
}: {
  title: string;
  count?: string;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-md border px-2.5 py-2 ${
      highlight ? 'border-yellow-500/20 bg-yellow-500/[0.03]' : 'border-white/[0.05] bg-white/[0.015]'
    }`}>
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{title}</span>
        {count && <span className="text-[10px] text-zinc-600">{count}</span>}
      </div>
      {children}
    </div>
  );
}

function getCapabilityPillTone(
  kind: 'skill' | 'connector' | 'mcp',
): 'skill' | 'connector' | 'mcp' {
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

function getQuickActionButtonClasses(action: WorkbenchQuickAction): string {
  return action.emphasis === 'primary'
    ? 'border-amber-500/30 bg-amber-500/10 text-amber-200 hover:border-amber-500/50 hover:bg-amber-500/15'
    : 'border-white/[0.08] bg-zinc-900/60 text-zinc-300 hover:border-white/[0.14] hover:text-zinc-100';
}

function CapabilityPillRow({
  items,
  onOpenCapability,
}: {
  items: TurnCapabilityScopeItem[];
  onOpenCapability: (target: WorkbenchCapabilityTarget) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <div key={`${item.kind}-${item.id}`} className="flex items-center gap-1">
          <WorkbenchPill tone={getCapabilityPillTone(item.kind)}>
            {item.label}
          </WorkbenchPill>
          <WorkbenchCapabilityDetailButton
            label={item.label}
            onClick={() => onOpenCapability({
              kind: item.kind,
              id: item.id,
            })}
            className="h-5 w-5"
          />
        </div>
      ))}
    </div>
  );
}

function InvokedCapabilityRows({
  items,
  onOpenCapability,
}: {
  items: TurnCapabilityInvocationItem[];
  onOpenCapability: (target: WorkbenchCapabilityTarget) => void;
}) {
  return (
    <div className="space-y-1.5">
      {items.map((item) => {
        const actionSummary = formatWorkbenchHistoryActionSummary(item.topActions, { maxActions: 2 });
        return (
          <div
            key={`${item.kind}-${item.id}`}
            className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5"
          >
            <WorkbenchPill tone={getCapabilityPillTone(item.kind)}>
              {item.label}
            </WorkbenchPill>
            <div className="min-w-0 flex-1 text-[11px] text-zinc-400">
              {actionSummary || '已调用'}
            </div>
            <div className="text-[10px] text-zinc-600">{item.count}x</div>
            <WorkbenchCapabilityDetailButton
              label={item.label}
              onClick={() => onOpenCapability({
                kind: item.kind,
                id: item.id,
              })}
              className="h-5 w-5"
            />
          </div>
        );
      })}
    </div>
  );
}

function getRoutingStepDotClass(step: TurnRoutingEvidenceStep): string {
  switch (step.tone) {
    case 'success':
      return 'bg-emerald-400';
    case 'warning':
      return 'bg-amber-400';
    case 'error':
      return 'bg-red-400';
    default:
      return 'bg-sky-400';
  }
}

function getRoutingModeLabel(mode: 'auto' | 'direct' | 'parallel'): string {
  switch (mode) {
    case 'auto':
      return 'Auto';
    case 'direct':
      return 'Direct';
    case 'parallel':
      return 'Parallel';
    default:
      return mode;
  }
}

function CompactCapabilityScopeSection({
  label,
  emptyLabel,
  hasContent,
  children,
}: {
  label: string;
  emptyLabel: string;
  hasContent: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md bg-black/10 px-2.5 py-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      {hasContent ? children : <div className="text-[11px] text-zinc-600">{emptyLabel}</div>}
    </div>
  );
}

function CurrentTurnCapabilityScopeCard({
  scopeView,
  blockedCapabilitiesWithActions,
  runningActionKey,
  actionErrors,
  completedActions,
  onQuickAction,
  onOpenCapability,
}: {
  scopeView: NonNullable<ReturnType<typeof useCurrentTurnCapabilityScope>>;
  blockedCapabilitiesWithActions: Array<{
    capability: WorkbenchCapabilityRegistryItem;
    actions: WorkbenchQuickAction[];
  }>;
  runningActionKey: string | null;
  actionErrors: Record<string, string>;
  completedActions: Record<string, { kind: WorkbenchQuickAction['kind']; completedAt: number }>;
  onQuickAction: (
    capability: WorkbenchCapabilityRegistryItem,
    action: WorkbenchQuickAction,
  ) => Promise<void>;
  onOpenCapability: (
    target: WorkbenchCapabilityTarget,
    blockedReason?: BlockedCapabilityReason | null,
  ) => void;
}) {
  const { scope } = scopeView;
  const hasRouting = scope.selected.length > 0 || scope.allowed.length > 0 || scope.blocked.length > 0;
  const title = hasRouting ? '能力范围' : '实际调用';
  const summary = hasRouting
    ? `已选 ${scope.selected.length} · 放行 ${scope.allowed.length} · 阻塞 ${scope.blocked.length} · 调用 ${scope.invoked.length}`
    : `调用 ${scope.invoked.length}`;
  const selectedCapabilityMap = new Map(
    scopeView.selectedCapabilities.map((capability) => [
      `${capability.kind}:${capability.id}`,
      capability,
    ]),
  );
  const blockedCapabilityMap = new Map(
    blockedCapabilitiesWithActions.map(({ capability, actions }) => [
      `${capability.kind}:${capability.id}`,
      { capability, actions },
    ]),
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-zinc-300">
        <Wrench className="h-3.5 w-3.5 text-amber-300" />
        <span>{title}</span>
        <span className="text-zinc-500">
          {summary}
        </span>
      </div>

      <div className="space-y-2">
        {scope.selected.length > 0 && (
          <CompactCapabilityScopeSection
            label="用户选择"
            emptyLabel=""
            hasContent
          >
            <CapabilityPillRow items={scope.selected} onOpenCapability={onOpenCapability} />
          </CompactCapabilityScopeSection>
        )}

        {scope.allowed.length > 0 && (
          <CompactCapabilityScopeSection
            label="运行时放行"
            emptyLabel=""
            hasContent
          >
            <CapabilityPillRow items={scope.allowed} onOpenCapability={onOpenCapability} />
          </CompactCapabilityScopeSection>
        )}

        {scope.blocked.length > 0 && (
          <CompactCapabilityScopeSection
            label="运行时阻塞"
            emptyLabel=""
            hasContent
          >
            <div className="space-y-2">
              {scope.blocked.map((reason) => {
                const currentCapability = selectedCapabilityMap.get(`${reason.kind}:${reason.id}`);
                const blockedCapability = blockedCapabilityMap.get(`${reason.kind}:${reason.id}`);
                const error = blockedCapability ? actionErrors[blockedCapability.capability.key] : null;
                const feedback = currentCapability
                  ? getWorkbenchCapabilityQuickActionFeedback(
                    currentCapability,
                    completedActions[currentCapability.key],
                  )
                  : null;

                return (
                  <div
                    key={`${reason.kind}-${reason.id}`}
                    className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5"
                  >
                    <div className="mb-1 flex items-center gap-1.5">
                      <WorkbenchPill tone={getCapabilityPillTone(reason.kind)}>
                        {reason.label}
                      </WorkbenchPill>
                      <span className={`text-[10px] ${reason.severity === 'error' ? 'text-red-300' : 'text-amber-300'}`}>
                        {reason.code}
                      </span>
                      <WorkbenchCapabilityDetailButton
                        label={reason.label}
                        onClick={() => onOpenCapability({
                          kind: reason.kind,
                          id: reason.id,
                        }, reason)}
                        className="ml-auto h-5 w-5"
                      />
                    </div>
                    <div className="text-xs text-zinc-200">{reason.detail}</div>
                    <div className="mt-1 text-[11px] text-zinc-500">{reason.hint}</div>
                    {blockedCapability && blockedCapability.actions.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {blockedCapability.actions.map((action) => {
                          const actionKey = `${blockedCapability.capability.key}:${action.kind}`;
                          const loading = runningActionKey === actionKey;
                          return (
                            <button
                              key={actionKey}
                              type="button"
                              onClick={() => void onQuickAction(blockedCapability.capability, action)}
                              disabled={loading}
                              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${getQuickActionButtonClasses(action)}`}
                            >
                              {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                              <span>{action.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {error && (
                      <div className="mt-1 text-[11px] text-red-300">{error}</div>
                    )}
                    {feedback && !error && (
                      <div className={`mt-1 text-[11px] ${feedback.tone === 'success' ? 'text-emerald-300' : 'text-sky-300'}`}>
                        {feedback.message}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CompactCapabilityScopeSection>
        )}

        {scope.invoked.length > 0 && (
          <CompactCapabilityScopeSection
            label={hasRouting ? '实际调用' : '调用明细'}
            emptyLabel=""
            hasContent
          >
            <InvokedCapabilityRows items={scope.invoked} onOpenCapability={onOpenCapability} />
          </CompactCapabilityScopeSection>
        )}
      </div>
    </div>
  );
}

function CurrentTurnRoutingEvidenceCard({
  routingView,
}: {
  routingView: NonNullable<ReturnType<typeof useCurrentTurnRoutingEvidence>>;
}) {
  const routing = routingView.routingEvidence;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-zinc-300">
        <GitBranch className="h-3.5 w-3.5 text-cyan-300" />
        <span>Routing 证据</span>
        <WorkbenchPill tone="info">{getRoutingModeLabel(routing.mode)}</WorkbenchPill>
      </div>

      <div className="rounded-md bg-black/10 px-2.5 py-2">
        <div className="text-xs text-zinc-100">{routing.summary}</div>
        {routing.reason && (
          <div className="mt-1 text-[11px] text-zinc-400">{routing.reason}</div>
        )}
      </div>

      <CompactCapabilityScopeSection
        label="Execution Steps"
        emptyLabel="当前没有额外的 routing 执行证据。"
        hasContent={routing.steps.length > 0}
      >
        <div className="space-y-1.5">
          {routing.steps.map((step, index) => (
            <div
              key={`${routing.mode}-${index}-${step.status}`}
              className="flex items-start gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5 text-[11px]"
            >
              <span className={`mt-[2px] h-1.5 w-1.5 rounded-full ${getRoutingStepDotClass(step)}`} />
              <div className="min-w-0">
                <div className="text-zinc-200">{step.label}</div>
                {step.detail && (
                  <div className="text-zinc-500">{step.detail}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </CompactCapabilityScopeSection>
    </div>
  );
}
