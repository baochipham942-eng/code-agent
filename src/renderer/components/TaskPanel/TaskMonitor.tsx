// ============================================================================
// TaskMonitor - StatusRail 主工作面视图
// ============================================================================
// 主卡片链路: TodoCard → ContextCard（主卡）→ OutputsCard → Turn Scope → ReferencesCard
// 数据统一来自 useStatusRailModel
// ============================================================================

import React, { useMemo, useCallback, useState } from 'react';
import type {
  BlockedCapabilityReason,
  TurnArtifactOwnershipItem,
  TurnCapabilityInvocationItem,
  TurnCapabilityScopeItem,
  TurnRoutingEvidenceStep,
} from '@shared/contract/turnTimeline';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { useStatusRailModel } from '../../hooks/useStatusRailModel';
import { useCurrentTurnArtifactOwnership } from '../../hooks/useCurrentTurnArtifactOwnership';
import { useCurrentTurnCapabilityScope } from '../../hooks/useCurrentTurnCapabilityScope';
import { useCurrentTurnRoutingEvidence } from '../../hooks/useCurrentTurnRoutingEvidence';
import { useWorkbenchCapabilityQuickActionRunner } from '../../hooks/useWorkbenchCapabilityQuickActionRunner';
import { useWorkbenchInsights } from '../../hooks/useWorkbenchInsights';
import {
  Check, Loader2, AlertTriangle,
  FileText, FolderOpen, Wrench, GitBranch,
} from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { classifyTool, PHASE_ICONS, formatElapsed, type PhaseType } from './taskPanelUtils';
import { useToolProgress } from './useToolProgress';
import { Card, CardEmptyState as EmptyState } from './Card';
import { ConnectorsCard } from './ConnectorsCard';
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
  const { currentSessionId, messages } = useSessionStore();
  const { workingDirectory } = useAppStore();
  const processingSessionIds = useAppStore((s) => s.processingSessionIds);
  const isProcessing = currentSessionId ? processingSessionIds.has(currentSessionId) : false;
  const { references: referencedWorkbenchItems, history: workbenchHistory } = useWorkbenchInsights();
  const currentTurnArtifactOwnership = useCurrentTurnArtifactOwnership();
  const currentTurnCapabilityScope = useCurrentTurnCapabilityScope();
  const currentTurnRoutingEvidence = useCurrentTurnRoutingEvidence();
  const { runningActionKey, actionErrors, completedActions, runQuickAction } = useWorkbenchCapabilityQuickActionRunner();
  const { t } = useI18n();
  const { toolTimeout } = useToolProgress(currentSessionId);

  const model = useStatusRailModel();
  const { context, todos: todoModel, outputs } = model;

  const [activeSheetEntry, setActiveSheetEntry] = useState<{
    target: WorkbenchCapabilityTarget;
    blockedReason?: BlockedCapabilityReason | null;
  } | null>(null);

  // ── Phase-based 进度推导（无 todos 时的回退）──
  const toolPhases = useMemo(() => {
    if (todoModel.total > 0) return [];
    const phases: Array<{ type: PhaseType; count: number; status: 'completed' | 'in_progress' }> = [];
    for (const msg of messages.slice(-30)) {
      if (!msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        const phase = classifyTool(tc.name);
        if (!phase) continue;
        const last = phases[phases.length - 1];
        if (last?.type === phase) {
          last.count++;
        } else {
          if (phases.length > 0) phases[phases.length - 1].status = 'completed';
          phases.push({ type: phase, count: 1, status: 'in_progress' });
        }
      }
    }
    if (phases.length > 0 && !isProcessing) {
      phases[phases.length - 1].status = 'completed';
    }
    return phases;
  }, [messages, todoModel.total, isProcessing]);

  const folderName = workingDirectory ? workingDirectory.split('/').pop() || workingDirectory : null;

  const phaseLabel = (type: PhaseType): string => {
    const map: Record<PhaseType, string> = {
      read: t.taskPanel.phaseRead,
      edit: t.taskPanel.phaseEdit,
      execute: t.taskPanel.phaseExecute,
      search: t.taskPanel.phaseSearch,
      mcp: t.taskPanel.phaseMcp,
    };
    return map[type];
  };

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

  // ── 渲染 ──

  return (
    <div className="space-y-2">
      {/* 工作目录 */}
      {folderName && (
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <FolderOpen className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">
            {t.taskPanel.workIn.replace('{folderName}', folderName)}
          </span>
        </div>
      )}

      {/* 超时警告 */}
      {toolTimeout && (
        <div className="flex items-center gap-2 text-xs text-amber-400/80 py-1">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{toolTimeout.toolName} {formatElapsed(toolTimeout.elapsedMs)}</span>
        </div>
      )}

      {/* ═══ Card 1: TodoCard ═══ */}
      <Card title={t.taskPanel.sectionTodos} count={todoModel.total > 0 ? `${todoModel.completed}/${todoModel.total}` : undefined} isEmpty={todoModel.total === 0 && toolPhases.length === 0} emptyLabel="空闲">
        {todoModel.total > 0 ? (
          <div className="space-y-0.5">
            {todoModel.items.map((todo, index) => (
              <div key={index} className="flex items-center gap-2 py-0.5">
                {todo.status === 'completed' ? (
                  <div className="w-4 h-4 rounded-full bg-primary-500 flex items-center justify-center flex-shrink-0">
                    <Check className="w-2.5 h-2.5 text-white" />
                  </div>
                ) : todo.status === 'in_progress' ? (
                  <div className="w-4 h-4 rounded-full bg-primary-500/20 flex items-center justify-center flex-shrink-0 animate-pulse">
                    <Loader2 className="w-2.5 h-2.5 text-primary-400 animate-spin" />
                  </div>
                ) : (
                  <div className="w-4 h-4 rounded-full border border-zinc-600 flex-shrink-0" />
                )}
                <span className={`text-xs truncate ${
                  todo.status === 'completed' ? 'text-zinc-500 line-through'
                    : todo.status === 'in_progress' ? 'text-zinc-200'
                    : 'text-zinc-400'
                }`}>
                  {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                </span>
              </div>
            ))}
          </div>
        ) : toolPhases.length > 0 ? (
          <div className="space-y-0.5">
            {toolPhases.map((phase, index) => {
              const PhaseIcon = PHASE_ICONS[phase.type];
              return (
                <div key={`${phase.type}-${index}`} className="flex items-center gap-2 py-0.5">
                  {phase.status === 'completed' ? (
                    <div className="w-4 h-4 rounded-full bg-primary-500 flex items-center justify-center flex-shrink-0">
                      <Check className="w-2.5 h-2.5 text-white" />
                    </div>
                  ) : (
                    <div className="w-4 h-4 rounded-full bg-primary-500/20 flex items-center justify-center flex-shrink-0 animate-pulse">
                      <PhaseIcon className="w-2.5 h-2.5 text-primary-400" />
                    </div>
                  )}
                  <span className={`text-xs flex-1 ${
                    phase.status === 'completed' ? 'text-zinc-500' : 'text-zinc-200'
                  }`}>
                    {phaseLabel(phase.type)}
                  </span>
                  <span className="text-xs text-zinc-600">
                    {t.taskPanel.phaseOps.replace('{count}', String(phase.count))}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState text={t.taskPanel.todosEmpty} />
        )}
      </Card>

      {/* ═══ Card 2: ContextCard — 仅展示百分比（详情与 Compact 在 ChatInput 的 ContextUsagePill 里） ═══ */}
      <Card
        title={t.taskPanel.sectionContext}
        highlight={context.warningLevel !== 'normal'}
      >
        <div className={`text-2xl font-semibold tabular-nums ${
          context.warningLevel === 'critical' ? 'text-red-400' :
          context.warningLevel === 'warning' ? 'text-yellow-400' :
          'text-emerald-400'
        }`}>
          {Math.round(context.usagePercent)}%
        </div>
      </Card>

      {/* ═══ Card 3: OutputsCard ═══ */}
      <Card
        title={t.taskPanel.sectionOutputs}
        count={currentTurnArtifactOwnership
          ? `#${currentTurnArtifactOwnership.turnNumber} · ${currentTurnArtifactOwnership.artifactOwnership.length}`
          : outputs.count > 0
            ? String(outputs.count)
            : undefined}
        highlight={currentTurnArtifactOwnership?.tone === 'warning' || currentTurnArtifactOwnership?.tone === 'error'}
        isEmpty={!currentTurnArtifactOwnership && outputs.count === 0}
        emptyLabel="0"
      >
        {currentTurnArtifactOwnership ? (
          <CurrentTurnArtifactOwnershipCard
            artifactView={currentTurnArtifactOwnership}
          />
        ) : outputs.count > 0 ? (
          <div className="space-y-0.5">
            {outputs.files.map((file) => (
              <div key={file.path} className="flex items-center gap-2 py-0.5" title={file.path}>
                <FileText className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                <span className="text-xs text-zinc-400 truncate font-mono">{file.name}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState text={t.taskPanel.artifactsEmpty} />
        )}
      </Card>

      {currentTurnCapabilityScope && (
        <Card
          title="当前 Turn Scope"
          count={`#${currentTurnCapabilityScope.turnNumber}`}
          highlight={currentTurnCapabilityScope.scope.blocked.length > 0}
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
        </Card>
      )}

      {currentTurnRoutingEvidence && (
        <Card
          title="当前 Turn Routing"
          count={`#${currentTurnRoutingEvidence.turnNumber}`}
          highlight={currentTurnRoutingEvidence.tone === 'warning' || currentTurnRoutingEvidence.tone === 'error'}
        >
          <CurrentTurnRoutingEvidenceCard
            routingView={currentTurnRoutingEvidence}
          />
        </Card>
      )}

      {/* ═══ Card 4: ReferencesCard ═══ */}
      <Card title={t.taskPanel.sectionReferences} isEmpty={referencedWorkbenchItems.length === 0} emptyLabel="0">
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
      </Card>

      {/* ═══ Card 5: ConnectorsCard ═══ */}
      <ConnectorsCard />

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

// ── Card 容器组件已抽到 ./Card ──

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
              {actionSummary || 'invoked'}
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

function getArtifactKindLabel(kind: TurnArtifactOwnershipItem['kind']): string {
  switch (kind) {
    case 'artifact':
      return 'Artifact';
    case 'link':
      return 'Link';
    case 'note':
      return 'Note';
    default:
      return 'File';
  }
}

function getArtifactPillTone(kind: TurnArtifactOwnershipItem['kind']): 'info' | 'neutral' {
  return kind === 'artifact' ? 'info' : 'neutral';
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
        <span>Scope Inspector Lite</span>
        <span className="text-zinc-500">
          已选 {scope.selected.length} · 放行 {scope.allowed.length} · 阻塞 {scope.blocked.length} · 调用 {scope.invoked.length}
        </span>
      </div>

      <div className="space-y-2">
        <CompactCapabilityScopeSection
          label="User Selected"
          emptyLabel="本轮没有显式选择 capability。"
          hasContent={scope.selected.length > 0}
        >
          <CapabilityPillRow items={scope.selected} onOpenCapability={onOpenCapability} />
        </CompactCapabilityScopeSection>

        <CompactCapabilityScopeSection
          label="Runtime Allowed"
          emptyLabel="当前没有被 runtime 放行的已选 capability。"
          hasContent={scope.allowed.length > 0}
        >
          <CapabilityPillRow items={scope.allowed} onOpenCapability={onOpenCapability} />
        </CompactCapabilityScopeSection>

        <CompactCapabilityScopeSection
          label="Runtime Blocked"
          emptyLabel="当前没有 runtime blocked capability。"
          hasContent={scope.blocked.length > 0}
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

        <CompactCapabilityScopeSection
          label="Actually Invoked"
          emptyLabel="本轮还没有 tool call 命中这些 capability。"
          hasContent={scope.invoked.length > 0}
        >
          <InvokedCapabilityRows items={scope.invoked} onOpenCapability={onOpenCapability} />
        </CompactCapabilityScopeSection>
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

function CurrentTurnArtifactOwnershipCard({
  artifactView,
}: {
  artifactView: NonNullable<ReturnType<typeof useCurrentTurnArtifactOwnership>>;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-zinc-300">
        <FileText className="h-3.5 w-3.5 text-emerald-300" />
        <span>本轮输出</span>
        <span className="text-zinc-500">
          {artifactView.artifactOwnership.length} 项
        </span>
      </div>

      <div className="space-y-1.5">
        {artifactView.artifactOwnership.map((item, index) => (
          <div
            key={`${item.kind}-${item.label}-${index}`}
            className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5"
          >
            <WorkbenchPill tone={getArtifactPillTone(item.kind)}>
              {getArtifactKindLabel(item.kind)}
            </WorkbenchPill>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-zinc-100">{item.label}</div>
              <div className="truncate text-[11px] text-zinc-500">{item.ownerLabel}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
