import React, { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Plug, Server, Sparkles, Wrench } from 'lucide-react';
import { useComposerStore } from '../../../stores/composerStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useCapabilityGapStore } from '../../../stores/capabilityGapStore';
import { GapCard } from '../capability/GapCard';
import { useWorkbenchCapabilityRegistry } from '../../../hooks/useWorkbenchCapabilityRegistry';
import { useWorkbenchCapabilityQuickActionRunner } from '../../../hooks/useWorkbenchCapabilityQuickActionRunner';
import { useWorkbenchInsights } from '../../../hooks/useWorkbenchInsights';
import {
  WorkbenchCapabilityDetailButton,
  WorkbenchPill,
  WorkbenchSectionHeader,
  WorkbenchSelectablePill,
} from '../../workbench/WorkbenchPrimitives';
import { WorkbenchCapabilitySheetLite } from '../../workbench/WorkbenchCapabilitySheetLite';
import { getWorkbenchCapabilityTitle } from '../../../utils/workbenchPresentation';
import type { WorkbenchCapabilityRegistryItem } from '../../../utils/workbenchCapabilityRegistry';
import {
  getWorkbenchCapabilityQuickActions,
  getWorkbenchCapabilityQuickActionFeedback,
  type WorkbenchQuickAction,
} from '../../../utils/workbenchQuickActions';
import {
  findWorkbenchCapabilityHistoryItem,
  resolveWorkbenchCapabilityFromSources,
  type WorkbenchCapabilityTarget,
} from '../../../utils/workbenchCapabilitySheet';

// Props 仍保留 —— 下游 ChatInput 还在透传 mention preview；实际 UI 在本次
// 简化后不展示这部分（routing / direct targets 已迁到 ChatInput AbilityMenu），
// 但 @mention 路由逻辑本身不变。
interface InlineWorkbenchBarProps {
  previewTargetAgentIds?: string[];
  onDirectTargetIdsChange?: (targetAgentIds: string[]) => void;
}

function getCapabilityTone(capability: WorkbenchCapabilityRegistryItem): 'skill' | 'connector' | 'mcp' {
  switch (capability.kind) {
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

function getCapabilityKindLabel(capability: WorkbenchCapabilityRegistryItem): string {
  switch (capability.kind) {
    case 'skill':
      return 'Skill';
    case 'connector':
      return 'Connector';
    case 'mcp':
      return 'MCP';
    default:
      return 'Capability';
  }
}

function getQuickActionButtonClasses(action: WorkbenchQuickAction): string {
  return action.emphasis === 'primary'
    ? 'border-amber-500/30 bg-amber-500/10 text-amber-200 hover:border-amber-500/50 hover:bg-amber-500/15'
    : 'border-border-muted bg-zinc-900/60 text-zinc-300 hover:border-border-hover hover:text-zinc-100';
}

function sortCapabilities<T extends WorkbenchCapabilityRegistryItem>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const rank = (item: WorkbenchCapabilityRegistryItem) => (
      item.selected ? 0 : item.available ? 1 : item.blocked ? 2 : 3
    );
    const rankDiff = rank(left) - rank(right);
    if (rankDiff !== 0) return rankDiff;
    return left.label.localeCompare(right.label);
  });
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

export const InlineWorkbenchBar: React.FC<InlineWorkbenchBarProps> = ({
  previewTargetAgentIds: _previewTargetAgentIds,
  onDirectTargetIdsChange: _onDirectTargetIdsChange,
}) => {
  const selectedSkillIds = useComposerStore((state) => state.selectedSkillIds);
  const setSelectedSkillIds = useComposerStore((state) => state.setSelectedSkillIds);
  const selectedConnectorIds = useComposerStore((state) => state.selectedConnectorIds);
  const setSelectedConnectorIds = useComposerStore((state) => state.setSelectedConnectorIds);
  const selectedMcpServerIds = useComposerStore((state) => state.selectedMcpServerIds);
  const setSelectedMcpServerIds = useComposerStore((state) => state.setSelectedMcpServerIds);
  const turnCapabilityScopeMode = useComposerStore((state) => state.turnCapabilityScopeMode);
  const setTurnCapabilityScopeMode = useComposerStore((state) => state.setTurnCapabilityScopeMode);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const gapNotice = useCapabilityGapStore((state) =>
    currentSessionId ? state.noticesBySession[currentSessionId] : null,
  );
  const dismissGapNotice = useCapabilityGapStore((state) => state.dismiss);
  const { skills, connectors, mcpServers } = useWorkbenchCapabilityRegistry();
  const { history } = useWorkbenchInsights();
  const { runningActionKey, actionErrors, completedActions, runQuickAction } = useWorkbenchCapabilityQuickActionRunner();
  const [activeSheetTarget, setActiveSheetTarget] = useState<WorkbenchCapabilityTarget | null>(null);
  // 聊天区默认折叠能力网格，避免占用输入视野。点击 header 切换展开。
  const [gridExpanded, setGridExpanded] = useState(false);
  const visibleSkills = useMemo(() => sortCapabilities(skills).slice(0, 24), [skills]);
  const visibleConnectors = useMemo(() => sortCapabilities(connectors).slice(0, 16), [connectors]);
  const visibleMcpServers = useMemo(() => sortCapabilities(mcpServers).slice(0, 16), [mcpServers]);
  const selectedSkillCount = skills.filter((skill) => skill.selected).length;
  const selectedConnectorCount = connectors.filter((connector) => connector.selected).length;
  const selectedMcpServerCount = mcpServers.filter((server) => server.selected).length;
  const skillOverflowCount = Math.max(0, skills.length - visibleSkills.length);
  const connectorOverflowCount = Math.max(0, connectors.length - visibleConnectors.length);
  const mcpOverflowCount = Math.max(0, mcpServers.length - visibleMcpServers.length);
  const registryItems = useMemo(
    () => [...skills, ...connectors, ...mcpServers],
    [connectors, mcpServers, skills],
  );
  const selectedCapabilities = useMemo(
    () => registryItems.filter((capability) => capability.selected),
    [registryItems],
  );
  const selectedPreviewCapabilities = useMemo(
    () => sortCapabilities(selectedCapabilities).slice(0, 8),
    [selectedCapabilities],
  );
  const selectedPreviewOverflowCount = Math.max(0, selectedCapabilities.length - selectedPreviewCapabilities.length);
  const blockedCapabilities = selectedCapabilities
    .map((capability) => ({
      capability,
      actions: getWorkbenchCapabilityQuickActions(capability),
    }))
    .filter(({ capability, actions }) => capability.selected && capability.blocked && actions.length > 0);
  const resolvedCapabilities = selectedCapabilities
    .filter((capability) => capability.selected && !capability.blocked && Boolean(completedActions[capability.key]))
    .map((capability) => ({
      capability,
      feedback: getWorkbenchCapabilityQuickActionFeedback(capability, completedActions[capability.key]),
    }))
    .filter(({ feedback }) => Boolean(feedback));
  const shouldShowSkills = visibleSkills.length > 0;
  const shouldShowConnectors = visibleConnectors.length > 0;
  const shouldShowMcpServers = visibleMcpServers.length > 0;
  const activeSheetCapability = useMemo(
    () => resolveWorkbenchCapabilityFromSources({
      target: activeSheetTarget,
      primaryItems: registryItems,
    }),
    [activeSheetTarget, registryItems],
  );
  const activeSheetHistory = useMemo(
    () => activeSheetTarget ? findWorkbenchCapabilityHistoryItem(history, activeSheetTarget) : null,
    [activeSheetTarget, history],
  );

  const toggleSkill = useCallback((skillId: string) => {
    setTurnCapabilityScopeMode('manual');
    setSelectedSkillIds(toggleId(selectedSkillIds, skillId));
  }, [selectedSkillIds, setSelectedSkillIds, setTurnCapabilityScopeMode]);

  const toggleConnector = useCallback((connectorId: string) => {
    setTurnCapabilityScopeMode('manual');
    setSelectedConnectorIds(toggleId(selectedConnectorIds, connectorId));
  }, [selectedConnectorIds, setSelectedConnectorIds, setTurnCapabilityScopeMode]);

  const toggleMcpServer = useCallback((serverId: string) => {
    setTurnCapabilityScopeMode('manual');
    setSelectedMcpServerIds(toggleId(selectedMcpServerIds, serverId));
  }, [selectedMcpServerIds, setSelectedMcpServerIds, setTurnCapabilityScopeMode]);

  const toggleCapability = useCallback((capability: WorkbenchCapabilityRegistryItem) => {
    if (capability.kind === 'skill') {
      toggleSkill(capability.id);
    } else if (capability.kind === 'connector') {
      toggleConnector(capability.id);
    } else if (capability.kind === 'mcp') {
      toggleMcpServer(capability.id);
    }
  }, [toggleConnector, toggleMcpServer, toggleSkill]);

  const openCapabilitySheet = useCallback((capability: WorkbenchCapabilityRegistryItem) => {
    setActiveSheetTarget({
      kind: capability.kind,
      id: capability.id,
    });
  }, []);

  // 首行的 workspace / Routing / Browser 已分别迁到 TitleBar 和 ChatInput AbilityMenu。
  // 这里保留用户本轮可显式选择的 Skills / Connectors / MCP。
  // 能力汇总行（"能力 · 自动匹配" / "Skills 0/131 · MCP 0/16"）在 Auto 态且没手动选时是纯噪音，
  // 整行隐藏；只有进了 Manual 或手动选了能力才显示。blocked/resolved 这类有信息量的区块不受影响。
  const hasManualSelection = selectedSkillCount + selectedConnectorCount + selectedMcpServerCount > 0;
  const showCapabilitySummary =
    (shouldShowSkills || shouldShowConnectors || shouldShowMcpServers)
    && (turnCapabilityScopeMode === 'manual' || hasManualSelection);
  const shouldRenderBar = showCapabilitySummary || blockedCapabilities.length > 0 || resolvedCapabilities.length > 0;
  const gapCardNode = gapNotice && currentSessionId ? (
    <GapCard
      requiredCapability={gapNotice.requiredCapability}
      gaps={gapNotice.gaps}
      onDismiss={() => dismissGapNotice(currentSessionId)}
    />
  ) : null;
  if (!shouldRenderBar) {
    return (
      <>
        {gapCardNode}
        <WorkbenchCapabilitySheetLite
          isOpen={Boolean(activeSheetCapability)}
          capability={activeSheetCapability}
          historyItem={activeSheetHistory}
          runningActionKey={runningActionKey}
          actionError={activeSheetCapability ? actionErrors[activeSheetCapability.key] : null}
          completedAction={activeSheetCapability ? completedActions[activeSheetCapability.key] : null}
          onQuickAction={runQuickAction}
          onClose={() => setActiveSheetTarget(null)}
        />
      </>
    );
  }

  // showCapabilitySummary 已保证只在 Manual / 已手动选能力时为真，这里直接给有意义的已选/可选计数。
  const summaryParts: string[] = [];
  if (shouldShowSkills) summaryParts.push(`Skills ${selectedSkillCount}/${skills.length}`);
  if (shouldShowConnectors) summaryParts.push(`Connectors ${selectedConnectorCount}/${connectors.length}`);
  if (shouldShowMcpServers) summaryParts.push(`MCP ${selectedMcpServerCount}/${mcpServers.length}`);
  const summaryText = summaryParts.join(' · ');

  return (
    <div className="mb-2 rounded-xl border border-border-muted bg-surface-subtle px-3 py-1.5">
      {showCapabilitySummary && (
        <>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setGridExpanded((v) => !v)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
              aria-expanded={gridExpanded}
            >
              {gridExpanded
                ? <ChevronDown className="h-3 w-3 shrink-0" />
                : <ChevronRight className="h-3 w-3 shrink-0" />}
              <span className="truncate">{summaryText || 'Capabilities'}</span>
            </button>
            <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-border-muted bg-zinc-950/40">
              <button
                type="button"
                onClick={() => setTurnCapabilityScopeMode('auto')}
                className={`px-2 py-0.5 text-[10px] transition-colors ${
                  turnCapabilityScopeMode === 'auto'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title="系统自动选择可用能力"
              >
                Auto
              </button>
              <button
                type="button"
                onClick={() => setTurnCapabilityScopeMode('manual')}
                className={`border-l border-border-muted px-2 py-0.5 text-[10px] transition-colors ${
                  turnCapabilityScopeMode === 'manual'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title="手动限定本轮能力范围"
              >
                Manual
              </button>
            </div>
          </div>

          {selectedPreviewCapabilities.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {selectedPreviewCapabilities.map((capability) => (
                <WorkbenchSelectablePill
                  key={`selected:${capability.key}`}
                  onClick={() => toggleCapability(capability)}
                  tone={getCapabilityTone(capability)}
                  selected
                  dimmed={!capability.available}
                  title={`${getWorkbenchCapabilityTitle(capability, { locale: 'zh' })}\n点击移出本轮范围`}
                >
                  {capability.label}
                </WorkbenchSelectablePill>
              ))}
              {selectedPreviewOverflowCount > 0 && (
                <span className="text-[11px] text-zinc-500">+{selectedPreviewOverflowCount}</span>
              )}
            </div>
          )}

          {gridExpanded && (
            <div className="mt-2 space-y-2">
              {shouldShowSkills && (
                <div>
                  <WorkbenchSectionHeader
                    icon={<Sparkles className="h-3.5 w-3.5 text-fuchsia-400" />}
                    label="Skills"
                    className="mb-1 px-0"
                    labelClassName="text-[11px] text-zinc-500"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {visibleSkills.length > 0 ? (
                      visibleSkills.map((skill) => (
                        <div key={skill.id} className="flex items-center gap-1">
                          <WorkbenchSelectablePill
                            onClick={() => toggleSkill(skill.id)}
                            tone="skill"
                            selected={skill.selected}
                            dimmed={!skill.available}
                            title={getWorkbenchCapabilityTitle(skill, { locale: 'zh' })}
                          >
                            {skill.label}
                          </WorkbenchSelectablePill>
                          <WorkbenchCapabilityDetailButton
                            label={skill.label}
                            onClick={() => openCapabilitySheet(skill)}
                          />
                        </div>
                      ))
                    ) : (
                      <span className="text-[11px] text-zinc-500">当前会话还没有 mounted skills。</span>
                    )}
                    {skillOverflowCount > 0 && (
                      <span className="text-[11px] text-zinc-500">+{skillOverflowCount}</span>
                    )}
                  </div>
                </div>
              )}

              {shouldShowConnectors && (
                <div>
                  <WorkbenchSectionHeader
                    icon={<Plug className="h-3.5 w-3.5 text-cyan-400" />}
                    label="Connectors"
                    className="mb-1 px-0"
                    labelClassName="text-[11px] text-zinc-500"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {visibleConnectors.map((connector) => (
                      <div key={connector.id} className="flex items-center gap-1">
                        <WorkbenchSelectablePill
                          onClick={() => toggleConnector(connector.id)}
                          tone="connector"
                          selected={connector.selected}
                          dimmed={!connector.available}
                          title={getWorkbenchCapabilityTitle(connector, { locale: 'zh' })}
                        >
                          {connector.label}
                        </WorkbenchSelectablePill>
                        <WorkbenchCapabilityDetailButton
                          label={connector.label}
                          onClick={() => openCapabilitySheet(connector)}
                        />
                      </div>
                    ))}
                    {connectorOverflowCount > 0 && (
                      <span className="text-[11px] text-zinc-500">+{connectorOverflowCount}</span>
                    )}
                  </div>
                </div>
              )}

              {shouldShowMcpServers && (
                <div>
                  <WorkbenchSectionHeader
                    icon={<Server className="h-3.5 w-3.5 text-blue-400" />}
                    label="MCP"
                    className="mb-1 px-0"
                    labelClassName="text-[11px] text-zinc-500"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {visibleMcpServers.map((server) => (
                      <div key={server.id} className="flex items-center gap-1">
                        <WorkbenchSelectablePill
                          onClick={() => toggleMcpServer(server.id)}
                          tone="mcp"
                          selected={server.selected}
                          dimmed={!server.available}
                          title={getWorkbenchCapabilityTitle(server, { locale: 'zh' })}
                        >
                          {server.label}
                        </WorkbenchSelectablePill>
                        <WorkbenchCapabilityDetailButton
                          label={server.label}
                          onClick={() => openCapabilitySheet(server)}
                        />
                      </div>
                    ))}
                    {mcpOverflowCount > 0 && (
                      <span className="text-[11px] text-zinc-500">+{mcpOverflowCount}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {blockedCapabilities.length > 0 && (
        <div className="mt-3 border-t border-border-muted pt-2">
          <WorkbenchSectionHeader
            icon={<Wrench className="h-3.5 w-3.5 text-amber-400" />}
            label="Quick Actions"
            count={blockedCapabilities.length}
            className="mb-2 px-0"
            labelClassName="text-[11px] text-zinc-500"
          />
          <div className="space-y-2">
            {blockedCapabilities.map(({ capability, actions }) => (
              <div
                key={capability.key}
                className="rounded-lg border border-amber-500/10 bg-amber-500/[0.04] px-2.5 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium text-zinc-200">{capability.label}</span>
                      <WorkbenchPill tone={getCapabilityTone(capability)}>
                        {getCapabilityKindLabel(capability)}
                      </WorkbenchPill>
                    </div>
                    <div className="mt-1 flex items-start gap-1.5 text-[11px] text-zinc-400">
                      <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-400/80" />
                      <span className="leading-relaxed">
                        {capability.blockedReason?.detail}
                      </span>
                    </div>
                    {capability.blockedReason?.hint && (
                      <div className="mt-1 text-[11px] text-zinc-500">
                        {capability.blockedReason.hint}
                      </div>
                    )}
                    {(() => {
                      const feedback = getWorkbenchCapabilityQuickActionFeedback(
                        capability,
                        completedActions[capability.key],
                      );
                      return feedback ? (
                        <div className={`mt-1 text-[11px] ${feedback.tone === 'success' ? 'text-emerald-300' : 'text-sky-300'}`}>
                          {feedback.message}
                        </div>
                      ) : null;
                    })()}
                    {actionErrors[capability.key] && (
                      <div className="mt-1 text-[11px] text-red-300">
                        {actionErrors[capability.key]}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {actions.map((action) => {
                    const actionKey = `${capability.key}:${action.kind}`;
                    const loading = runningActionKey === actionKey;
                    return (
                      <button
                        key={actionKey}
                        type="button"
                        onClick={() => void runQuickAction(capability, action)}
                        disabled={loading}
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${getQuickActionButtonClasses(action)}`}
                      >
                        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                        <span>{action.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {resolvedCapabilities.length > 0 && (
        <div className="mt-3 border-t border-border-muted pt-2">
          <WorkbenchSectionHeader
            icon={<Check className="h-3.5 w-3.5 text-emerald-400" />}
            label="Ready Next Turn"
            count={resolvedCapabilities.length}
            className="mb-2 px-0"
            labelClassName="text-[11px] text-zinc-500"
          />
          <div className="space-y-2">
            {resolvedCapabilities.map(({ capability, feedback }) => (
              <div
                key={capability.key}
                className="rounded-lg border border-emerald-500/10 bg-emerald-500/[0.04] px-2.5 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-zinc-200">{capability.label}</span>
                  <WorkbenchPill tone={getCapabilityTone(capability)}>
                    {getCapabilityKindLabel(capability)}
                  </WorkbenchPill>
                </div>
                {feedback && (
                  <div className="mt-1 text-[11px] text-emerald-300">
                    {feedback.message}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {gapCardNode}
      <WorkbenchCapabilitySheetLite
        isOpen={Boolean(activeSheetCapability)}
        capability={activeSheetCapability}
        historyItem={activeSheetHistory}
        runningActionKey={runningActionKey}
        actionError={activeSheetCapability ? actionErrors[activeSheetCapability.key] : null}
        completedAction={activeSheetCapability ? completedActions[activeSheetCapability.key] : null}
        onQuickAction={runQuickAction}
        onClose={() => setActiveSheetTarget(null)}
      />
    </div>
  );
};

export default InlineWorkbenchBar;
