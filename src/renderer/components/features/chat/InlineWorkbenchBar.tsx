import React, { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Check, FolderOpen, GitBranch, Globe, Loader2, Plug, Sparkles, Wrench } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { BrowserSessionMode, ConversationRoutingMode } from '@shared/contract/conversationEnvelope';
import { useComposerStore } from '../../../stores/composerStore';
import { useAppStore } from '../../../stores/appStore';
import { useSwarmStore } from '../../../stores/swarmStore';
import { useWorkbenchCapabilityRegistry } from '../../../hooks/useWorkbenchCapabilityRegistry';
import { useWorkbenchBrowserSession } from '../../../hooks/useWorkbenchBrowserSession';
import { useWorkbenchCapabilityQuickActionRunner } from '../../../hooks/useWorkbenchCapabilityQuickActionRunner';
import { useWorkbenchInsights } from '../../../hooks/useWorkbenchInsights';
import ipcService from '../../../services/ipcService';
import { isWebMode } from '../../../utils/platform';
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
import { buildDirectRoutingHint } from './ChatInput/agentMentionRouting';
import {
  findWorkbenchCapabilityHistoryItem,
  resolveWorkbenchCapabilityFromSources,
  type WorkbenchCapabilityTarget,
} from '../../../utils/workbenchCapabilitySheet';

interface InlineWorkbenchBarProps {
  previewTargetAgentIds?: string[];
  onDirectTargetIdsChange?: (targetAgentIds: string[]) => void;
}

const ROUTING_LABELS: Record<ConversationRoutingMode, string> = {
  auto: 'Auto',
  direct: 'Direct',
  parallel: 'Parallel',
};

const BROWSER_SESSION_LABELS: Record<BrowserSessionMode, string> = {
  none: 'Off',
  managed: 'Managed',
  desktop: 'Desktop',
};

function hasSameAgentTargets(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
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

function getBrowserSessionSummaryLabel(mode: BrowserSessionMode): string {
  switch (mode) {
    case 'managed':
      return '托管浏览器';
    case 'desktop':
      return '当前桌面浏览器上下文';
    default:
      return '未接入';
  }
}

function formatRelativeTimestamp(timestamp?: number | null): string {
  if (!timestamp) {
    return '暂无';
  }

  const diffMs = Math.max(0, Date.now() - timestamp);
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) {
    return '刚刚';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} 天前`;
}

function getBrowserModeButtonClasses(selected: boolean): string {
  return selected
    ? 'bg-primary-500/20 text-primary-300'
    : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200';
}

export const InlineWorkbenchBar: React.FC<InlineWorkbenchBarProps> = ({
  previewTargetAgentIds = [],
  onDirectTargetIdsChange,
}) => {
  const workingDirectory = useComposerStore((state) => state.workingDirectory);
  const routingMode = useComposerStore((state) => state.routingMode);
  const targetAgentIds = useComposerStore((state) => state.targetAgentIds);
  const browserSessionMode = useComposerStore((state) => state.browserSessionMode);
  const selectedSkillIds = useComposerStore((state) => state.selectedSkillIds);
  const selectedConnectorIds = useComposerStore((state) => state.selectedConnectorIds);
  const selectedMcpServerIds = useComposerStore((state) => state.selectedMcpServerIds);
  const setWorkingDirectory = useComposerStore((state) => state.setWorkingDirectory);
  const setRoutingMode = useComposerStore((state) => state.setRoutingMode);
  const setTargetAgentIds = useComposerStore((state) => state.setTargetAgentIds);
  const setBrowserSessionMode = useComposerStore((state) => state.setBrowserSessionMode);
  const setSelectedSkillIds = useComposerStore((state) => state.setSelectedSkillIds);
  const setSelectedConnectorIds = useComposerStore((state) => state.setSelectedConnectorIds);
  const setSelectedMcpServerIds = useComposerStore((state) => state.setSelectedMcpServerIds);
  const setAppWorkingDirectory = useAppStore((state) => state.setWorkingDirectory);
  const selectedSwarmAgentId = useAppStore((state) => state.selectedSwarmAgentId);
  const agents = useSwarmStore((state) => state.agents);
  const { skills, connectors, mcpServers } = useWorkbenchCapabilityRegistry();
  const browserSession = useWorkbenchBrowserSession();
  const { history } = useWorkbenchInsights();
  const { runningActionKey, actionErrors, completedActions, runQuickAction } = useWorkbenchCapabilityQuickActionRunner();
  const [activeSheetTarget, setActiveSheetTarget] = useState<WorkbenchCapabilityTarget | null>(null);
  const hasMentionPreview = previewTargetAgentIds.length > 0;
  const mentionPreviewOverridesSelection = hasMentionPreview
    && (
      routingMode !== 'direct'
      || !hasSameAgentTargets(previewTargetAgentIds, targetAgentIds)
    );
  const displayRoutingMode = hasMentionPreview ? 'direct' : routingMode;
  const displayTargetAgentIds = hasMentionPreview ? previewTargetAgentIds : targetAgentIds;
  const selectedAgents = agents.filter((agent) => displayTargetAgentIds.includes(agent.id));
  const activeSkills = skills.filter((skill) => skill.visibleInWorkbench);
  const activeConnectors = connectors.filter((connector) => connector.visibleInWorkbench);
  const activeMcpServers = mcpServers.filter((server) => server.visibleInWorkbench);
  const registryItems = useMemo(
    () => [...skills, ...connectors, ...mcpServers],
    [connectors, mcpServers, skills],
  );
  const blockedCapabilities = [...activeSkills, ...activeConnectors, ...activeMcpServers]
    .map((capability) => ({
      capability,
      actions: getWorkbenchCapabilityQuickActions(capability),
    }))
    .filter(({ capability, actions }) => capability.selected && capability.blocked && actions.length > 0);
  const resolvedCapabilities = [...activeSkills, ...activeConnectors, ...activeMcpServers]
    .filter((capability) => capability.selected && !capability.blocked && Boolean(completedActions[capability.key]))
    .map((capability) => ({
      capability,
      feedback: getWorkbenchCapabilityQuickActionFeedback(capability, completedActions[capability.key]),
    }))
    .filter(({ feedback }) => Boolean(feedback));
  const shouldShowSkills = activeSkills.length > 0;
  const shouldShowConnectors = activeConnectors.length > 0;
  const shouldShowMcp = activeMcpServers.length > 0;
  const directHint = displayRoutingMode === 'direct' && !hasMentionPreview
    ? buildDirectRoutingHint(selectedAgents, agents)
    : null;
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

  const handleSelectDirectory = useCallback(async () => {
    try {
      let selectedPath: string | null = null;
      if (isWebMode()) {
        selectedPath = window.prompt('输入工作目录路径', workingDirectory || '')?.trim() || null;
      } else {
        selectedPath = await ipcService.invoke(IPC_CHANNELS.WORKSPACE_SELECT_DIRECTORY);
      }

      if (selectedPath) {
        setWorkingDirectory(selectedPath);
        setAppWorkingDirectory(selectedPath);
      }
    } catch (error) {
      console.error('Failed to select working directory:', error);
    }
  }, [setAppWorkingDirectory, setWorkingDirectory, workingDirectory]);

  const handleRoutingModeChange = useCallback((mode: ConversationRoutingMode) => {
    setRoutingMode(mode);
    if (mode === 'direct' && targetAgentIds.length === 0 && selectedSwarmAgentId) {
      const nextIds = [selectedSwarmAgentId];
      setTargetAgentIds(nextIds);
      onDirectTargetIdsChange?.(nextIds);
    }
  }, [onDirectTargetIdsChange, selectedSwarmAgentId, setRoutingMode, setTargetAgentIds, targetAgentIds.length]);

  const toggleAgent = useCallback((agentId: string) => {
    const baseIds = displayTargetAgentIds;
    const nextIds = baseIds.includes(agentId)
      ? baseIds.filter((id) => id !== agentId)
      : [...baseIds, agentId];
    setTargetAgentIds(nextIds);
    onDirectTargetIdsChange?.(nextIds);
  }, [displayTargetAgentIds, onDirectTargetIdsChange, setTargetAgentIds]);

  const toggleSkill = useCallback((skillId: string) => {
    const nextIds = selectedSkillIds.includes(skillId)
      ? selectedSkillIds.filter((id) => id !== skillId)
      : [...selectedSkillIds, skillId];
    setSelectedSkillIds(nextIds);
  }, [selectedSkillIds, setSelectedSkillIds]);

  const toggleConnector = useCallback((connectorId: string) => {
    const nextIds = selectedConnectorIds.includes(connectorId)
      ? selectedConnectorIds.filter((id) => id !== connectorId)
      : [...selectedConnectorIds, connectorId];
    setSelectedConnectorIds(nextIds);
  }, [selectedConnectorIds, setSelectedConnectorIds]);

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

  const workspaceLabel = workingDirectory
    ? workingDirectory.split('/').filter(Boolean).pop() || workingDirectory
    : '选择目录';
  const shouldShowBrowserPreview = browserSessionMode !== 'none';
  const browserModeSummary = getBrowserSessionSummaryLabel(browserSessionMode);
  const browserPreviewTitle = browserSession.preview?.title || '暂无标题';
  const browserPreviewUrl = browserSession.preview?.url || '暂无 URL';
  const browserFrontmostApp = browserSession.preview?.frontmostApp || '未检测到';
  const browserLastScreenshot = formatRelativeTimestamp(browserSession.preview?.lastScreenshotAtMs);

  return (
    <div className="mb-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSelectDirectory}
          className="inline-flex items-center gap-2 rounded-lg border border-white/[0.08] bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-white/[0.14] hover:text-zinc-100"
          title={workingDirectory || '选择工作目录'}
        >
          <FolderOpen className="h-3.5 w-3.5 text-amber-400" />
          <span className="max-w-[180px] truncate">{workspaceLabel}</span>
        </button>

        <div className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-zinc-900/60 p-1">
          <span className="inline-flex items-center gap-1 px-1.5 text-[11px] text-zinc-500">
            <GitBranch className="h-3.5 w-3.5" />
            Routing
          </span>
          {(['auto', 'direct', 'parallel'] as ConversationRoutingMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleRoutingModeChange(mode)}
              className={`rounded-md px-2 py-1 text-xs transition-colors ${
                displayRoutingMode === mode
                  ? 'bg-primary-500/20 text-primary-300'
                  : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200'
              }`}
            >
              {ROUTING_LABELS[mode]}
            </button>
          ))}
        </div>

        <div className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-zinc-900/60 p-1">
          <span className="inline-flex items-center gap-1 px-1.5 text-[11px] text-zinc-500">
            <Globe className="h-3.5 w-3.5" />
            Browser
          </span>
          {(['none', 'managed', 'desktop'] as BrowserSessionMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setBrowserSessionMode(mode)}
              className={`rounded-md px-2 py-1 text-xs transition-colors ${getBrowserModeButtonClasses(browserSessionMode === mode)}`}
            >
              {BROWSER_SESSION_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      {shouldShowBrowserPreview && (
        <div className="mt-2 rounded-lg border border-white/[0.06] bg-black/10 px-2.5 py-2">
          <WorkbenchSectionHeader
            icon={<Globe className="h-3.5 w-3.5 text-cyan-300" />}
            label="Browser Session"
            className="mb-2 px-0"
            labelClassName="text-[11px] text-zinc-500"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <WorkbenchPill tone="info">
              {browserModeSummary}
            </WorkbenchPill>
            <WorkbenchPill tone={browserSession.blocked ? 'neutral' : 'info'}>
              {browserSession.blocked ? '未就绪' : '已就绪'}
            </WorkbenchPill>
            {browserSessionMode === 'managed' && (
              <WorkbenchPill tone={browserSession.managedSession.running ? 'info' : 'neutral'}>
                {browserSession.managedSession.running ? '托管浏览器已启动' : '托管浏览器未启动'}
              </WorkbenchPill>
            )}
          </div>

          <div className="mt-2 grid gap-2 text-[11px] text-zinc-300 sm:grid-cols-2">
            <div className="min-w-0 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">Current Title</div>
              <div className="mt-1 truncate text-zinc-200" title={browserPreviewTitle}>
                {browserPreviewTitle}
              </div>
            </div>
            <div className="min-w-0 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">Current URL</div>
              <div className="mt-1 truncate text-zinc-200" title={browserPreviewUrl}>
                {browserPreviewUrl}
              </div>
            </div>
            <div className="min-w-0 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">Mode</div>
              <div className="mt-1 text-zinc-200">
                {browserModeSummary}
              </div>
            </div>
            {browserSessionMode === 'desktop' && (
              <div className="min-w-0 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Frontmost App</div>
                <div className="mt-1 truncate text-zinc-200" title={browserFrontmostApp}>
                  {browserFrontmostApp}
                </div>
              </div>
            )}
            {browserSessionMode === 'desktop' && (
              <div className="min-w-0 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5 sm:col-span-2">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Recent Screenshot</div>
                <div className="mt-1 text-zinc-200">
                  {browserLastScreenshot}
                </div>
              </div>
            )}
          </div>

          {browserSessionMode === 'desktop' && (
            <div className="mt-3">
              <WorkbenchSectionHeader
                icon={<Wrench className="h-3.5 w-3.5 text-amber-400" />}
                label="Desktop Readiness"
                className="mb-2 px-0"
                labelClassName="text-[11px] text-zinc-500"
              />
              <div className="grid gap-2 sm:grid-cols-2">
                {browserSession.readinessItems.map((item) => (
                  <div
                    key={item.key}
                    className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-zinc-300">{item.label}</span>
                      <span className={`text-[10px] ${item.ready ? 'text-emerald-300' : 'text-amber-300'}`}>
                        {item.value}
                      </span>
                    </div>
                    {item.detail && (
                      <div className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                        {item.detail}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {browserSession.blocked && (
            <div className="mt-3 rounded-lg border border-amber-500/10 bg-amber-500/[0.04] px-2.5 py-2">
              <div className="flex items-start gap-1.5 text-[11px] text-zinc-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-400/80" />
                <span className="leading-relaxed">
                  {browserSession.blockedDetail}
                </span>
              </div>
              {browserSession.blockedHint && (
                <div className="mt-1 text-[11px] text-zinc-500">
                  {browserSession.blockedHint}
                </div>
              )}
              {browserSession.actionError && (
                <div className="mt-1 text-[11px] text-red-300">
                  {browserSession.actionError}
                </div>
              )}
              {browserSession.repairActions.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {browserSession.repairActions.map((action) => {
                    const loading = browserSession.busyActionKind === action.kind;
                    return (
                      <button
                        key={action.kind}
                        type="button"
                        onClick={() => void browserSession.runRepairAction(action)}
                        disabled={loading}
                        className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200 transition-colors hover:border-amber-500/50 hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                        <span>{action.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {(shouldShowSkills || shouldShowConnectors || shouldShowMcp) && (
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

          {shouldShowConnectors && (
            <div>
              <WorkbenchSectionHeader
                icon={<Plug className="h-3.5 w-3.5 text-sky-400" />}
                label="Connectors"
                className="mb-1 px-0"
                labelClassName="text-[11px] text-zinc-500"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                {activeConnectors.map((connector) => {
                  return (
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
                  );
                })}
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

      {(displayRoutingMode === 'direct') && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-1.5">
          {hasMentionPreview && (
            <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-300">
              {mentionPreviewOverridesSelection
                ? '本次发送以前缀 @agent 为准，会覆盖当前 Routing 选择'
                : '本次发送由开头 @agent 指定'}
            </span>
          )}
          {agents.length > 0 ? (
            agents.map((agent) => {
              const selected = displayTargetAgentIds.includes(agent.id);
              return (
                <WorkbenchSelectablePill
                  key={agent.id}
                  onClick={() => toggleAgent(agent.id)}
                  tone="agent"
                  selected={selected}
                  title={agent.role}
                >
                  {agent.name}
                </WorkbenchSelectablePill>
              );
            })
          ) : (
            <span className="text-[11px] text-zinc-500">当前没有可选 agent，先保留 Direct 意图。</span>
          )}
          </div>
          {directHint && (
            <div className="mt-2 text-[11px] text-zinc-500">
              {directHint}
            </div>
          )}
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
