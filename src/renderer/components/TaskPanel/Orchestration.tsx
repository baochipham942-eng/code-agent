// ============================================================================
// Orchestration - Multi-agent orchestration visualization for TaskPanel
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Ban,
  CheckCircle2,
  Clock,
  FileText,
  GitBranch,
  Loader2,
  MessageSquare,
  MessageSquareText,
  ShieldAlert,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Users,
  XCircle,
  Zap,
} from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import { useSwarmStore } from '../../stores/swarmStore';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import ipcService from '../../services/ipcService';
import SwarmDependencyMap from './SwarmDependencyMap';
import { ContextInterventionPanel } from './ContextInterventionPanel';
import { ContextProvenancePanel } from './ContextProvenancePanel';
import { LaunchRequestCard } from '../features/swarm/LaunchRequestCard';
import { SwarmTraceHistory } from '../features/swarm/SwarmTraceHistory';
import type {
  ContextInterventionAction,
  ContextViewResponse,
} from '@shared/contract/contextView';
import { formatDuration } from '../../../shared/utils/format';
import {
  AgentContextCard,
  AgentLaneCard,
  ApprovalCard,
  MetricCard,
  Section,
} from './orchestration/components';
import {
  buildContextDistribution,
  buildContextTimeline,
  buildProvenanceEntries,
  formatTokens,
  getUsageTextClass,
  getUsageToneClass,
  isContextViewResponse,
  phaseMeta,
  summarizeContextSources,
  toneClassMap,
} from './orchestration/model';

export const Orchestration: React.FC = () => {
  const { setShowAgentTeamPanel, setSelectedSwarmAgentId, contextHealth: appContextHealth } = useAppStore();
  const { currentSessionId, messages, sessionRuntimes } = useSessionStore();
  const {
    isRunning,
    startTime,
    agents,
    statistics,
    aggregation,
    verification,
    executionPhase,
    launchRequests,
    planReviews,
    eventLog,
    lastEventAt,
  } = useSwarmStore();
  const [delegateMode, setDelegateMode] = useState(false);
  const [delegateModeLoading, setDelegateModeLoading] = useState(true);
  const [delegateModePending, setDelegateModePending] = useState(false);
  const [cancelingAgentId, setCancelingAgentId] = useState<string | null>(null);
  const [retryingAgentId, setRetryingAgentId] = useState<string | null>(null);
  const [contextView, setContextView] = useState<ContextViewResponse | null>(null);
  const [contextViewLoading, setContextViewLoading] = useState(false);
  const [interventionLoadingId, setInterventionLoadingId] = useState<string | null>(null);
  const [selectedContextAgentId, setSelectedContextAgentId] = useState<string | null>(null);

  const runtimeContextHealth = currentSessionId
    ? sessionRuntimes.get(currentSessionId)?.contextHealth ?? null
    : null;
  const contextHealth = runtimeContextHealth ?? appContextHealth ?? null;
  const contextSources = useMemo(() => summarizeContextSources(messages), [messages]);
  const contextTimeline = useMemo(
    () => buildContextTimeline(messages, contextView, contextHealth),
    [messages, contextView, contextHealth],
  );
  const agentContextSnapshots = useMemo(
    () => agents.filter((agent) => Boolean(agent.contextSnapshot)),
    [agents],
  );

  const pendingLaunches = useMemo(
    () => launchRequests.filter((request) => request.status === 'pending'),
    [launchRequests],
  );
  const resolvedLaunches = useMemo(
    () => launchRequests.filter((request) => request.status !== 'pending').slice(-2).reverse(),
    [launchRequests],
  );
  const pendingReviews = useMemo(
    () => planReviews.filter((review) => review.status === 'pending'),
    [planReviews],
  );
  const resolvedReviews = useMemo(
    () => planReviews.filter((review) => review.status !== 'pending').slice(-3).reverse(),
    [planReviews],
  );
  const recentEvents = useMemo(() => eventLog.slice(-8).reverse(), [eventLog]);
  const activeLaunchRequest = pendingLaunches[0] || launchRequests[launchRequests.length - 1];
  const selectedContextAgent = useMemo(
    () => selectedContextAgentId
      ? agents.find((agent) => agent.id === selectedContextAgentId) ?? null
      : null,
    [agents, selectedContextAgentId],
  );
  const interventionItems = useMemo(
    () => (contextView?.contextItems ?? []).slice(-6).reverse(),
    [contextView],
  );
  const provenanceEntries = useMemo(() => buildProvenanceEntries(contextView), [contextView]);

  if (!isRunning && agents.length === 0 && launchRequests.length === 0 && planReviews.length === 0 && !aggregation) {
    return (
      <div className="space-y-3">
        <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] p-4">
          <div className="flex items-center gap-2 text-zinc-300">
            <GitBranch className="w-4 h-4 text-primary-400" />
            <span className="text-sm font-medium">编排视图</span>
          </div>
          <div className="mt-3 text-xs leading-6 text-zinc-500">
            当前没有活跃的多 agent 编排。触发并行执行后，这里会显示 agent 泳道、审批队列、协作动态和最终汇总。
          </div>
        </div>
        <SwarmTraceHistory />
      </div>
    );
  }

  const displayAgentCount = statistics.total || activeLaunchRequest?.agentCount || agents.length;
  const progressPercent = statistics.total > 0
    ? ((statistics.completed + statistics.failed + statistics.running * 0.5) / statistics.total) * 100
    : pendingLaunches.length > 0
    ? 8
    : 0;
  const elapsed = startTime ? formatDuration(Date.now() - startTime) : '0s';
  const phase = phaseMeta[executionPhase];
  const contextUsagePercent = contextView?.usagePercent ?? contextHealth?.usagePercent ?? 0;
  const contextTotalTokens = contextView?.totalTokens ?? contextHealth?.currentTokens ?? 0;
  const contextMaxTokens = contextView?.maxTokens ?? contextHealth?.maxTokens ?? 0;
  const contextDistribution = buildContextDistribution(contextView, contextHealth);
  const compressionCount = contextView?.compressionStatus.totalCommits
    ?? contextHealth?.compression?.compressionCount
    ?? 0;
  const compressionSavedTokens = contextView?.compressionStatus.savedTokens
    ?? contextHealth?.compression?.totalSavedTokens
    ?? 0;
  const compressionLayers = contextView?.compressionStatus.layersTriggered
    ?? (contextHealth?.compression?.compressionCount ? ['autocompact'] : []);
  const messagePreview = contextView?.apiViewPreview.slice(0, 6) ?? [];

  useEffect(() => {
    let cancelled = false;

    ipcService.invoke(IPC_CHANNELS.SWARM_GET_DELEGATE_MODE)
      .then((enabled) => {
        if (!cancelled) {
          setDelegateMode(Boolean(enabled));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDelegateModeLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentSessionId) {
      setContextView(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setContextViewLoading(true);
      ipcService.invoke(IPC_CHANNELS.CONTEXT_GET_VIEW, {
        sessionId: currentSessionId,
        agentId: selectedContextAgentId ?? undefined,
      })
        .then((result) => {
          if (!cancelled) {
            setContextView(isContextViewResponse(result) ? result : null);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setContextView(null);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setContextViewLoading(false);
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentSessionId, lastEventAt, selectedContextAgentId]);

  useEffect(() => {
    if (!selectedContextAgentId) return;
    const exists = agents.some((agent) => agent.id === selectedContextAgentId);
    if (!exists) {
      setSelectedContextAgentId(null);
    }
  }, [agents, selectedContextAgentId]);

  const openAgentTeam = (agentId: string) => {
    setSelectedSwarmAgentId(agentId);
    setShowAgentTeamPanel(true);
  };

  const toggleDelegateMode = async () => {
    const next = !delegateMode;
    setDelegateModePending(true);
    try {
      await ipcService.invoke(IPC_CHANNELS.SWARM_SET_DELEGATE_MODE, next);
      setDelegateMode(next);
    } finally {
      setDelegateModePending(false);
    }
  };

  const cancelAgent = async (agentId: string) => {
    setCancelingAgentId(agentId);
    try {
      await ipcService.invoke(IPC_CHANNELS.SWARM_CANCEL_AGENT, { agentId });
    } finally {
      setCancelingAgentId((current) => (current === agentId ? null : current));
    }
  };

  const retryAgent = async (agentId: string) => {
    setRetryingAgentId(agentId);
    try {
      await ipcService.invoke(IPC_CHANNELS.SWARM_RETRY_AGENT, { agentId });
    } finally {
      setRetryingAgentId((current) => (current === agentId ? null : current));
    }
  };

  const handleContextIntervention = async (
    itemId: string,
    action: ContextInterventionAction,
    enabled: boolean,
  ) => {
    if (!currentSessionId) {
      return;
    }

    setInterventionLoadingId(itemId);
    try {
      await ipcService.invoke(IPC_CHANNELS.CONTEXT_INTERVENTION_SET, {
        sessionId: currentSessionId,
        agentId: selectedContextAgentId ?? undefined,
        messageId: itemId,
        action,
        enabled,
      });
    } finally {
      setInterventionLoadingId((current) => (current === itemId ? null : current));
    }
  };

  return (
    <div className="space-y-3">
      <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] p-3">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-primary-400" />
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">编排态势</span>
          <button
            onClick={() => {
              setSelectedSwarmAgentId(null);
              setShowAgentTeamPanel(true);
            }}
            className="ml-auto flex items-center gap-1 rounded-md border border-white/[0.06] bg-zinc-800/80 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-primary-500/20 hover:text-zinc-100"
          >
            <MessageSquare className="w-3 h-3" />
            协作
          </button>
          <button
            onClick={toggleDelegateMode}
            disabled={delegateModeLoading || delegateModePending}
            className="flex items-center gap-1 rounded-md border border-white/[0.06] bg-zinc-800/80 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-primary-500/20 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
            title="开启后优先走 delegate 编排路径"
          >
            {delegateMode ? (
              <ToggleRight className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <ToggleLeft className="w-3.5 h-3.5 text-zinc-500" />
            )}
            {delegateModePending ? '切换中…' : delegateMode ? '接管开' : '接管关'}
          </button>
          <span className={`rounded-full px-2 py-1 text-[11px] ${phase.className}`}>
            {phase.label}
          </span>
        </div>

        <div className="mt-2 flex items-center justify-between text-sm">
          <div className="text-zinc-100">
            {displayAgentCount} 个 agent
            <span className="ml-2 text-zinc-500">
              {pendingLaunches.length > 0 && !isRunning
                ? '等待启动确认'
                : `${statistics.running} 运行 / ${statistics.pending} 等待 / ${statistics.completed} 完成`}
            </span>
          </div>
          <div className="text-xs text-zinc-500">{elapsed}</div>
        </div>

        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary-500 via-cyan-400 to-emerald-400 transition-all duration-300"
            style={{ width: `${Math.min(100, Math.max(progressPercent, isRunning ? 8 : 0))}%` }}
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <MetricCard
            icon={<Users className="w-3.5 h-3.5 text-primary-400" />}
            label="并行峰值"
            value={statistics.parallelPeak || statistics.running}
            emphasis="text-primary-300"
          />
          <MetricCard
            icon={<ShieldAlert className="w-3.5 h-3.5 text-amber-400" />}
            label="待确认"
            value={pendingLaunches.length + pendingReviews.length}
            emphasis={pendingLaunches.length + pendingReviews.length > 0 ? 'text-amber-300' : 'text-zinc-200'}
          />
          <MetricCard
            icon={<Ban className="w-3.5 h-3.5 text-red-400" />}
            label="阻塞中"
            value={agents.filter((agent) => agent.status === 'failed' || agent.status === 'cancelled').length}
            emphasis="text-red-300"
          />
          <MetricCard
            icon={<Zap className="w-3.5 h-3.5 text-cyan-400" />}
            label="总 Token"
            value={formatTokens(statistics.totalTokens)}
            emphasis="text-cyan-300"
          />
          <MetricCard
            icon={<FileText className="w-3.5 h-3.5 text-emerald-400" />}
            label="变更文件"
            value={aggregation?.filesChanged.length ?? 0}
            emphasis="text-emerald-300"
          />
        </div>
      </div>

      {launchRequests.length > 0 && (
        <Section
          title="启动确认"
          extra={
            pendingLaunches.length > 0 ? (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                {pendingLaunches.length} 待确认
              </span>
            ) : undefined
          }
          defaultExpanded
        >
          <div className="space-y-2">
            {pendingLaunches.map((request) => (
              <LaunchRequestCard key={request.id} request={request} />
            ))}
            {pendingLaunches.length === 0 && resolvedLaunches.map((request) => (
              <LaunchRequestCard key={request.id} request={request} />
            ))}
          </div>
        </Section>
      )}

      {activeLaunchRequest && (
        <Section title="依赖拓扑" defaultExpanded>
          <SwarmDependencyMap
            launchRequest={activeLaunchRequest}
            agents={agents}
            phase={executionPhase}
            parallelPeak={statistics.parallelPeak}
            lastEventAt={lastEventAt}
            selectedAgentId={selectedContextAgentId}
            onAgentSelect={setSelectedContextAgentId}
          />
        </Section>
      )}

      {(contextHealth || contextView || contextViewLoading) && (
        <Section
          title="上下文空间"
          extra={
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${getUsageTextClass(contextUsagePercent)}`}>
              {contextUsagePercent.toFixed(1)}%
            </span>
          }
        >
          <div className="space-y-3">
            <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-zinc-100">Context Budget</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {selectedContextAgent
                      ? `当前仅展示 ${selectedContextAgent.name} (${selectedContextAgent.id}) 的上下文视图`
                      : '当前展示全局上下文视图；点击 DAG agent 节点可切到对应 subagent'}
                  </div>
                </div>
                {selectedContextAgentId && (
                  <button
                    onClick={() => setSelectedContextAgentId(null)}
                    className="rounded-md border border-white/[0.06] bg-zinc-900/70 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-primary-500/20 hover:text-zinc-100"
                  >
                    查看全局
                  </button>
                )}
                {contextViewLoading && (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
                )}
              </div>

              <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-900/80">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${getUsageToneClass(contextUsagePercent)}`}
                  style={{ width: `${Math.min(100, contextUsagePercent)}%` }}
                />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <MetricCard
                  icon={<Zap className="w-3.5 h-3.5 text-cyan-400" />}
                  label="上下文预算"
                  value={`${formatTokens(contextTotalTokens)} / ${formatTokens(contextMaxTokens)}`}
                  emphasis={getUsageTextClass(contextUsagePercent)}
                />
                <MetricCard
                  icon={<Clock className="w-3.5 h-3.5 text-emerald-400" />}
                  label="预估剩余"
                  value={contextHealth ? `~${contextHealth.estimatedTurnsRemaining} 轮` : '—'}
                  emphasis="text-emerald-300"
                />
                <MetricCard
                  icon={<Activity className="w-3.5 h-3.5 text-violet-400" />}
                  label="消息视图"
                  value={contextView?.messageCount ?? messages.length}
                  emphasis="text-violet-300"
                />
                <MetricCard
                  icon={<ShieldAlert className="w-3.5 h-3.5 text-amber-400" />}
                  label="健康等级"
                  value={contextHealth?.warningLevel ?? 'normal'}
                  emphasis={getUsageTextClass(contextUsagePercent)}
                />
              </div>
            </div>

            {contextDistribution.length > 0 && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="text-sm font-medium text-zinc-100">Context Breakdown</div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {contextDistribution.map((entry) => {
                    const percent = contextTotalTokens > 0
                      ? `${((entry.value / contextTotalTokens) * 100).toFixed(1)}%`
                      : '0.0%';

                    return (
                      <div key={entry.label} className="rounded bg-zinc-900/70 px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">{entry.label}</div>
                        <div className={`mt-1 text-sm font-medium ${entry.tone}`}>{formatTokens(entry.value)}</div>
                        <div className="mt-1 text-[10px] text-zinc-600">{percent}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="text-sm font-medium text-zinc-100">Compression</div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                    提交次数 <span className="ml-1 text-zinc-200">{compressionCount}</span>
                  </div>
                  <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                    节省 Token <span className="ml-1 text-emerald-300">{formatTokens(compressionSavedTokens)}</span>
                  </div>
                  <div className="col-span-2 rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                    触发层 <span className="ml-1 text-zinc-200">{compressionLayers.length > 0 ? compressionLayers.join(', ') : '—'}</span>
                  </div>
                  {contextView && (
                    <div className="col-span-2 rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                      裁剪状态
                      <span className="ml-1 text-zinc-200">
                        snip {contextView.compressionStatus.snippedCount} / collapse {contextView.compressionStatus.collapsedSpans}
                      </span>
                    </div>
                  )}
                </div>
              </div>

            <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
              <div className="text-sm font-medium text-zinc-100">Context Sources</div>
              <div className="mt-2 text-xs text-zinc-500">最近 20 条消息里被带入上下文的附件与工具</div>
              <div className="mt-3 space-y-2">
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Attachments</div>
                  <div className="flex flex-wrap gap-1.5">
                    {contextSources.attachments.length > 0 ? contextSources.attachments.map((name) => (
                      <span
                        key={name}
                        className="rounded bg-zinc-900/80 px-1.5 py-0.5 text-[10px] text-zinc-300"
                        title={name}
                      >
                        {name}
                      </span>
                    )) : (
                      <span className="text-[10px] text-zinc-600">无附件上下文</span>
                    )}
                  </div>
                </div>
                  <div>
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Tools</div>
                    <div className="flex flex-wrap gap-1.5">
                      {contextSources.tools.length > 0 ? contextSources.tools.map((name) => (
                        <span
                          key={name}
                          className="rounded bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300"
                        >
                          {name}
                        </span>
                      )) : (
                        <span className="text-[10px] text-zinc-600">无工具上下文</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {interventionItems.length > 0 && (
              <ContextInterventionPanel
                items={interventionItems}
                submittingId={interventionLoadingId}
                onAction={handleContextIntervention}
              />
            )}

            {provenanceEntries.length > 0 && (
              <ContextProvenancePanel entries={provenanceEntries} />
            )}

            {contextTimeline.length > 0 && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary-400" />
                  <div className="text-sm font-medium text-zinc-100">Context Timeline</div>
                </div>
                <div className="mt-3 space-y-2">
                  {contextTimeline.map((entry) => (
                    <div
                      key={entry.id}
                      className={`rounded-lg border px-3 py-2 ${toneClassMap[entry.tone]}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">{entry.title}</span>
                        <span className="ml-auto text-[10px] text-zinc-500">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="mt-1 text-xs leading-5">{entry.summary}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {agentContextSnapshots.length > 0 && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-primary-400" />
                  <div className="text-sm font-medium text-zinc-100">Agent Context Snapshots</div>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
                  {agentContextSnapshots.map((agent) => (
                    <AgentContextCard key={`ctx-${agent.id}`} agent={agent} />
                  ))}
                </div>
              </div>
            )}

            {messagePreview.length > 0 && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="text-sm font-medium text-zinc-100">API View Preview</div>
                <div className="mt-3 space-y-2">
                  {messagePreview.map((item) => (
                    <div
                      key={item.id}
                      className="rounded border border-white/[0.04] bg-zinc-900/70 px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-zinc-700/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                          {item.role}
                        </span>
                        <span className="ml-auto text-[10px] text-zinc-500">{formatTokens(item.tokens)} tokens</span>
                      </div>
                      <div className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-400">
                        {item.contentPreview}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {agents.length > 0 && (
        <Section
          title="Agent 泳道"
          extra={<span className="text-[11px] text-zinc-600">{agents.length}</span>}
        >
          <div className="space-y-2">
            {agents.map((agent) => (
              <AgentLaneCard
                key={agent.id}
                agent={agent}
                onOpenTeam={openAgentTeam}
                onCancelAgent={cancelAgent}
                onRetryAgent={retryAgent}
                canceling={cancelingAgentId === agent.id}
                retrying={retryingAgentId === agent.id}
              />
            ))}
          </div>
        </Section>
      )}

      {(pendingReviews.length > 0 || resolvedReviews.length > 0) && (
        <Section
          title="审批队列"
          extra={
            pendingReviews.length > 0 ? (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                {pendingReviews.length} 待处理
              </span>
            ) : undefined
          }
        >
          <div className="space-y-2">
            {pendingReviews.map((review) => (
              <ApprovalCard key={review.id} review={review} />
            ))}
            {pendingReviews.length === 0 && resolvedReviews.map((review) => (
              <ApprovalCard key={review.id} review={review} />
            ))}
          </div>
        </Section>
      )}

      {recentEvents.length > 0 && (
        <Section title="协作动态" extra={<MessageSquareText className="w-3.5 h-3.5 text-zinc-500" />}>
          <div className="space-y-2">
            {recentEvents.map((event) => (
              <div
                key={event.id}
                className={`rounded-lg border px-3 py-2 ${toneClassMap[event.tone]}`}
              >
                <div className="flex items-center gap-2">
                  <Activity className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">{event.title}</span>
                  <span className="ml-auto text-[10px] text-zinc-500">
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div className="mt-1 text-xs leading-5">{event.summary}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {(aggregation || verification) && (
        <Section title="结果收口" extra={<Sparkles className="w-3.5 h-3.5 text-violet-400" />}>
          <div className="space-y-3">
            {aggregation && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="text-sm font-medium text-zinc-100">聚合摘要</div>
                <div className="mt-2 text-xs leading-6 text-zinc-400">{aggregation.summary}</div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                    加速比 <span className="ml-1 text-cyan-300">{aggregation.speedup.toFixed(1)}x</span>
                  </div>
                  <div className="rounded bg-zinc-900/70 px-2 py-1.5 text-zinc-400">
                    成功率 <span className="ml-1 text-emerald-300">{(aggregation.successRate * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </div>
            )}

            {verification && (
              <div className="rounded-lg border border-white/[0.04] bg-zinc-800/70 p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                  {verification.passed ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-400" />
                  )}
                  验证{verification.passed ? '通过' : '未通过'}
                  <span className="ml-auto text-xs text-zinc-500">
                    {(verification.score * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {verification.checks.map((check) => (
                    <span
                      key={`${check.name}-${check.passed}`}
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        check.passed
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-red-500/15 text-red-300'
                      }`}
                      title={check.message}
                    >
                      {check.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}
      {/* ADR-010 #5: 历史 swarm runs 回看面板，跟随主视图滚动 */}
      <SwarmTraceHistory />
    </div>
  );
};

export default Orchestration;
