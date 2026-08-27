// ============================================================================
// SessionAgentsPanel - 右栏「专家」一级页签内容（N-L6-AGENTVIEW S2）
// ----------------------------------------------------------------------------
// 爸 08-22 拍板改形：不做 pill 展开态，借鉴 Codex App / Cursor 的右侧代理面板——
// 本会话所有代理（专家 + 普通代理 + delegate_task 后台任务）一列看完，点一行进
// 该代理的对话视图（S3）。顶部 标题 + 「合没合」一句 + 停止全部；行级「停」；
// 「讨论流」收为面板内「事件」折叠区；底部 token/耗时一行。
// 一根脊柱：全部数据来自 useSessionAgentRows（useSessionMembers + agentTree 快照
// + backgroundTaskStore），本组件不另起第二份状态、不自己拉 IPC 轮询。
// 面板不画输入框：对代理续话是后置单 N-SUBAGENT-INPUT。
// ============================================================================

import React, { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Clock, Square, X, Zap } from 'lucide-react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import { cancelSwarmRunOrFallback } from '../features/swarm/SwarmInlineMonitor';
import ipcService from '../../services/ipcService';
import { useI18n } from '../../hooks/useI18n';
import { useSessionAgentRows } from '../../hooks/useSessionAgentRows';
import { useDurableSwarmRunDetail } from '../../hooks/useDurableSwarmRunDetail';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { useComposerStore } from '../../stores/composerStore';
import { useMemberViewStore } from '../../stores/memberViewStore';
import { useVoiceCallStore } from '../../stores/voiceCallStore';
import { deriveAgentMergeState } from '../../utils/agentMergeState';
import type { AgentRow } from '../../utils/agentRows';
import { RoleInitialAvatar } from '../features/expert/RoleInitialAvatar';
import { DiscussionStream } from '../features/swarm/DiscussionStream';


// ponytail: 三行格式化，与成员条历史实现同口径，不提前抽 util
function formatPanelTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatPanelDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

export const SessionAgentsPanel: React.FC = () => {
  const { t } = useI18n();
  const text = t.expert.memberBar;
  const sessionId = useSessionStore((state) => state.currentSessionId);
  const { rows, conflicts } = useSessionAgentRows(sessionId);
  const durableDetail = useDurableSwarmRunDetail(sessionId);
  const activeRunId = useSwarmStore((state) => state.activeRunId);
  const eventLogLength = useSwarmStore((state) => (state.eventLog ?? []).length);
  const setViewingMemberId = useMemberViewStore((state) => state.setViewingMemberId);
  const setWorkbenchCollapsed = useAppStore((state) => state.setWorkbenchCollapsed);
  // 通话中高亮通话身份（与旧成员条 pill 同口径，S1 后落在面板行上）
  const voiceCallLive = useVoiceCallStore((state) => state.phase === 'live' || state.phase === 'connecting');
  const voiceActiveAgentId = useVoiceCallStore((state) => state.activeAgentId);
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);

  const mergeState = deriveAgentMergeState(rows, conflicts);
  const stoppableRows = rows.filter((row) => row.stoppable);
  const totalTokens = durableDetail
    ? durableDetail.run.totalTokensIn + durableDetail.run.totalTokensOut
    : 0;
  const elapsedMs = durableDetail
    ? (durableDetail.run.endedAt ?? Date.now()) - durableDetail.run.startedAt
    : null;

  const nameOf = (agentId: string): string =>
    rows.find((row) => row.key === agentId)?.name ?? agentId;

  // standby ×：把该成员从本次预选排除（启动时少起这个人）；
  // × 到最后一个不剩 = 整团取消，清掉配方预选本身（排除标记随 setSelectedTeamRecipeId 一并复位）
  const removeStandbyMember = (row: AgentRow) => {
    const standbyKey = row.member?.standbyKey;
    if (!standbyKey) return;
    const store = useComposerStore.getState();
    const remaining = rows.filter((candidate) => candidate.member?.standbyKey !== standbyKey);
    if (remaining.length === 0) {
      store.setSelectedTeamRecipeId(null);
      return;
    }
    store.setStandbyExcludedMemberKeys([...store.standbyExcludedMemberKeys, standbyKey]);
  };

  // 行级停：三类各走既有通道——Team 成员 swarm:cancel-agent；普通代理 agent.closeAgent
  // （close_agent 工具的 IPC 形态）；后台任务 task.cancelBackgroundTask（TaskManager 既有方法）
  const stopRow = async (row: AgentRow) => {
    if (stoppingKey) return;
    setStoppingKey(row.key);
    try {
      if (row.kind === 'expert') {
        if (!sessionId || !activeRunId) return;
        await ipcService
          .invoke(IPC_CHANNELS.SWARM_CANCEL_AGENT, { sessionId, runId: activeRunId, agentId: row.key })
          .catch(() => false);
      } else if (row.kind === 'agent') {
        await ipcService
          .invokeDomain(IPC_DOMAINS.AGENT, 'closeAgent', { agentId: row.key, sessionId })
          .catch(() => null);
      } else {
        await window.domainAPI
          ?.invoke(IPC_DOMAINS.TASK, 'cancelBackgroundTask', { taskId: row.key })
          .catch(() => null);
      }
    } finally {
      setStoppingKey(null);
    }
  };

  const stopAll = async () => {
    if (stoppingAll || stoppableRows.length === 0) return;
    setStoppingAll(true);
    try {
      const expertRows = stoppableRows.filter((row) => row.kind === 'expert');
      const swarmStop = sessionId && activeRunId && expertRows.length > 0
        ? cancelSwarmRunOrFallback({ sessionId, runId: activeRunId }, expertRows.map((row) => ({ id: row.key })))
        : Promise.resolve();
      await Promise.all([swarmStop, ...stoppableRows.map((row) => {
        if (row.kind === 'expert') return Promise.resolve();
        if (row.kind === 'agent') {
          return ipcService
            .invokeDomain(IPC_DOMAINS.AGENT, 'closeAgent', { agentId: row.key, sessionId })
            .catch(() => null);
        }
        return window.domainAPI
          ?.invoke(IPC_DOMAINS.TASK, 'cancelBackgroundTask', { taskId: row.key })
          .catch(() => null);
      })]);
    } finally {
      setStoppingAll(false);
    }
  };

  const statusLabel = (row: AgentRow): string => {
    const labels = text.panel.status;
    if (row.status === 'failed') {
      return row.failureReason
        ? `${labels.failed}：${row.failureReason}`
        : labels.failed;
    }
    return labels[row.status];
  };

  const mergeLabel = mergeState === 'merged'
    ? text.mergeState.merged.replace('{count}', String(rows.filter((row) => row.status !== 'standby').length))
    : mergeState === 'conflict'
      ? text.mergeState.conflict.replace('{count}', String(conflicts.length))
      : mergeState === 'waiting'
        ? text.mergeState.waiting
        : null;

  return (
    <div data-testid="session-agents-panel" className="flex h-full flex-col">
      <header className="flex items-center gap-2">
        <h2 className="flex-1 text-xs font-semibold text-zinc-200">{text.panel.title}</h2>
        {stoppableRows.length > 0 && (
          <button /* ds-allow:button: 面板顶部停止全部是超小文本按钮，与 TaskPanel tab 同档 */
            type="button"
            data-testid="agents-panel-stop-all"
            onClick={() => { void stopAll(); }}
            disabled={stoppingAll}
            className="rounded-md px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-badge-danger disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stoppingAll ? text.stopAllStopping : text.stopAll}
          </button>
        )}
        <button /* ds-allow:button: 关闭右栏是图标级小按钮，Button primitive 无此紧凑图标变体 */
          type="button"
          data-testid="agents-panel-close"
          onClick={() => setWorkbenchCollapsed(true)}
          aria-label={text.panel.closeAria}
          className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>

      {mergeLabel && (
        <p data-testid="agents-panel-merge-state" className="mt-2 text-[11px] text-zinc-400">
          {mergeLabel}
        </p>
      )}

      {conflicts.length > 0 && (
        <ul data-testid="agents-panel-conflicts" className="mt-2 space-y-1">
          {conflicts.map((conflict) => (
            <li
              key={`${conflict.path}-${conflict.ownerAgentId}-${conflict.requesterAgentId}`}
              className="rounded-md bg-zinc-950/40 px-2 py-1.5 text-[11px] text-badge-warning"
            >
              {text.panel.conflictLine
                .replace('{left}', nameOf(conflict.ownerAgentId))
                .replace('{right}', nameOf(conflict.requesterAgentId))
                .replace('{file}', conflict.path.split('/').pop() ?? conflict.path)}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex-1 space-y-1 overflow-y-auto">
        {rows.length === 0 && (
          <p data-testid="agents-panel-empty" className="text-[11px] text-zinc-500">{text.panel.empty}</p>
        )}
        {rows.map((row) => {
          const voiceActive = voiceCallLive && (row.key === voiceActiveAgentId || row.roleId === voiceActiveAgentId);
          return (
            <div
              key={row.key}
              data-testid={`agents-panel-row-${row.key}`}
              data-voice-active={voiceActive || undefined}
              className={`group flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
                voiceActive
                  ? 'border-badge-success/70 bg-emerald-500/10 ring-1 ring-emerald-400/40'
                  : 'border-zinc-800 bg-zinc-900/60'
              }`}
            >
              <button /* ds-allow:button: 行本体（头像+两行文字）是进成员对话视图的入口，Button primitive 无此形态 */
                type="button"
                data-testid={`agents-panel-open-${row.key}`}
                onClick={() => setViewingMemberId(row.key)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {row.kind === 'expert' ? (
                  <RoleInitialAvatar
                    roleId={row.roleId ?? row.name}
                    name={row.name}
                    icon={row.icon}
                    className="h-6 w-6 shrink-0 text-[10px]"
                  />
                ) : (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-400">
                    <Bot className="h-3.5 w-3.5" aria-hidden />
                  </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="flex items-center gap-1">
                    <span className="truncate text-xs font-medium text-zinc-100">{row.name}</span>
                    {row.isLead && (
                      <span
                        data-testid={`member-lead-badge-${row.roleId ?? row.key}`}
                        className="shrink-0 rounded bg-amber-400/15 px-1 py-0.5 text-[9px] font-medium leading-none text-badge-warning"
                      >
                        {text.leadLabel}
                      </span>
                    )}
                    {row.kind === 'task' && (
                      <span className="shrink-0 rounded bg-zinc-800 px-1 py-0.5 text-[9px] leading-none text-zinc-400">
                        {text.panel.backgroundBadge}
                      </span>
                    )}
                  </span>
                  {row.activity && (
                    <span className="truncate text-[11px] text-zinc-400">{row.activity}</span>
                  )}
                  <span
                    data-testid={`agents-panel-status-${row.key}`}
                    className={`text-[10px] ${
                      row.status === 'failed'
                        ? 'text-badge-danger'
                        : row.status === 'waiting'
                          ? 'text-badge-warning'
                          : 'text-zinc-500'
                    }`}
                  >
                    {statusLabel(row)}
                  </span>
                </span>
              </button>
              {row.status === 'standby' && row.member?.standbyKey && (
                <button /* ds-allow:button: standby 成员的删除是图标级小按钮，Button primitive 无此紧凑图标变体 */
                  type="button"
                  data-testid={`member-standby-remove-${row.roleId ?? row.key}`}
                  onClick={() => removeStandbyMember(row)}
                  aria-label={text.standbyRemoveAria.replace('{name}', row.name)}
                  className="shrink-0 rounded-full p-0.5 text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
              {row.stoppable && (
                <button /* ds-allow:button: 行级停是超小文本按钮，与面板顶部停止全部同档 */
                  type="button"
                  data-testid={`agents-panel-stop-${row.key}`}
                  onClick={() => { void stopRow(row); }}
                  disabled={stoppingKey === row.key}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-badge-danger disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Square className="mr-0.5 inline h-2.5 w-2.5" aria-hidden />
                  {stoppingKey === row.key ? text.stopAllStopping : text.panel.stopRow}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {eventLogLength > 0 && (
        <div className="mt-2 border-t border-white/[0.06] pt-2">
          <button /* ds-allow:button: 事件折叠区开关是超小文本按钮，与 TaskPanel tab 同档 */
            type="button"
            data-testid="agents-panel-events-toggle"
            onClick={() => setEventsOpen((open) => !open)}
            className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            {eventsOpen
              ? <ChevronDown className="h-3 w-3" aria-hidden />
              : <ChevronRight className="h-3 w-3" aria-hidden />}
            {text.panel.eventsToggle.replace('{count}', String(eventLogLength))}
          </button>
          {eventsOpen && (
            <div data-testid="agents-panel-events" className="mt-1 max-h-64 overflow-y-auto">
              <DiscussionStream />
            </div>
          )}
        </div>
      )}

      {(totalTokens > 0 || (elapsedMs !== null && elapsedMs > 0)) && (
        <div data-testid="agents-panel-usage" className="mt-2 flex items-center gap-3 border-t border-white/[0.06] pt-2 text-[11px] text-zinc-500">
          {totalTokens > 0 && (
            <span className="inline-flex items-center gap-1" title={text.tokensTitle}>
              <Zap className="h-3 w-3" aria-hidden />
              {formatPanelTokens(totalTokens)}
            </span>
          )}
          {elapsedMs !== null && elapsedMs > 0 && (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden />
              {formatPanelDuration(elapsedMs)}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
