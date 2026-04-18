import React, { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2, Plug, Sparkles, Wrench } from 'lucide-react';
import { useComposerStore } from '../../../stores/composerStore';
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
    : 'border-white/[0.08] bg-zinc-900/60 text-zinc-300 hover:border-white/[0.14] hover:text-zinc-100';
}

export const InlineWorkbenchBar: React.FC<InlineWorkbenchBarProps> = ({
  previewTargetAgentIds: _previewTargetAgentIds,
  onDirectTargetIdsChange: _onDirectTargetIdsChange,
}) => {
  const selectedSkillIds = useComposerStore((state) => state.selectedSkillIds);
  const selectedMcpServerIds = useComposerStore((state) => state.selectedMcpServerIds);
  const setSelectedSkillIds = useComposerStore((state) => state.setSelectedSkillIds);
  const setSelectedMcpServerIds = useComposerStore((state) => state.setSelectedMcpServerIds);
  const { skills, connectors, mcpServers } = useWorkbenchCapabilityRegistry();
  const { history } = useWorkbenchInsights();
  const { runningActionKey, actionErrors, completedActions, runQuickAction } = useWorkbenchCapabilityQuickActionRunner();
  const [activeSheetTarget, setActiveSheetTarget] = useState<WorkbenchCapabilityTarget | null>(null);
  const activeSkills = skills.filter((skill) => skill.visibleInWorkbench);
  const activeMcpServers = mcpServers.filter((server) => server.visibleInWorkbench);
  // connectors 保留在 registry 查询里，仅供 sheet 通过 capability key 反查（历史面板引用等）；
  // UI 不再展示 connector 选择器（#2），也不把 blocked connector 塞进 Quick Actions。
  const registryItems = useMemo(
    () => [...skills, ...connectors, ...mcpServers],
    [connectors, mcpServers, skills],
  );
  const blockedCapabilities = [...activeSkills, ...activeMcpServers]
    .map((capability) => ({
      capability,
      actions: getWorkbenchCapabilityQuickActions(capability),
    }))
    .filter(({ capability, actions }) => capability.selected && capability.blocked && actions.length > 0);
  const resolvedCapabilities = [...activeSkills, ...activeMcpServers]
    .filter((capability) => capability.selected && !capability.blocked && Boolean(completedActions[capability.key]))
    .map((capability) => ({
      capability,
      feedback: getWorkbenchCapabilityQuickActionFeedback(capability, completedActions[capability.key]),
    }))
    .filter(({ feedback }) => Boolean(feedback));
  const shouldShowSkills = activeSkills.length > 0;
  const shouldShowMcp = activeMcpServers.length > 0;
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
    const nextIds = selectedSkillIds.includes(skillId)
      ? selectedSkillIds.filter((id) => id !== skillId)
      : [...selectedSkillIds, skillId];
    setSelectedSkillIds(nextIds);
  }, [selectedSkillIds, setSelectedSkillIds]);

  const toggleMcpServer = useCallback((serverId: string) => {
    const nextIds = selectedMcpServerIds.includes(serverId)
      ? selectedMcpServerIds.filter((id) => id !== serverId)
      : [...selectedMcpServerIds, serverId];
    setSelectedMcpServerIds(nextIds);
  }, [selectedMcpServerIds, setSelectedMcpServerIds]);

  const openCapabilitySheet = useCallback((capability: WorkbenchCapabilityRegistryItem) => {
    setActiveSheetTarget({
      kind: capability.kind,
      id: capability.id,
    });
  }, []);

  // 首行的 workspace / Routing / Browser 已分别迁到 TitleBar 和 ChatInput AbilityMenu；
  // Browser preview 面板（URL/Title/Frontmost/Readiness/Repair）已整体移除，避免多处
  // workbench 源同时展示且互相漂移。InlineWorkbenchBar 现在只保留 skills / MCP /
  // blocked capabilities 的只读投影。
  const shouldRenderBar = shouldShowSkills || shouldShowMcp || blockedCapabilities.length > 0 || resolvedCapabilities.length > 0;
  if (!shouldRenderBar) {
    return (
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
    );
  }

  return (
    <div className="mb-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2">
      {(shouldShowSkills || shouldShowMcp) && (
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
                {activeSkills.length > 0 ? (
                  activeSkills.map((skill) => {
                    return (
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
                    );
                  })
                ) : (
                  <span className="text-[11px] text-zinc-500">当前会话还没有 mounted skills。</span>
                )}
              </div>
            </div>
          )}

          {shouldShowMcp && (
            <div>
              <WorkbenchSectionHeader
                icon={<Plug className="h-3.5 w-3.5 text-emerald-400" />}
                label="MCP"
                className="mb-1 px-0"
                labelClassName="text-[11px] text-zinc-500"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                {activeMcpServers.length > 0 ? (
                  activeMcpServers.map((server) => {
                    return (
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
                    );
                  })
                ) : (
                  <span className="text-[11px] text-zinc-500">当前没有可选 MCP server。</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {blockedCapabilities.length > 0 && (
        <div className="mt-3 border-t border-white/[0.06] pt-2">
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
        <div className="mt-3 border-t border-white/[0.06] pt-2">
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
