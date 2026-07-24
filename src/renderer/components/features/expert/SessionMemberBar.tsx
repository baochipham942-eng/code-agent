// ============================================================================
// SessionMemberBar - 输入框正上方的团队成员条
// ============================================================================
// 两种数据源，同一条：
//   1) 预选：用户在「＋ → 团队」选了配方但还没发第一句话 —— 灰态名单，让他先知道
//      这个团队由谁组成（WorkBuddy 不做这一步，只在真 spawn 后才铺；我们多给一层可预期性）
//   2) 运行时：会话真的跑起来了（实时 swarm 成员，或从账本回灌的历史 run）—— 带状态
// 第一颗 pill 永远是「主会话」（团长位），点它回主对话；点成员打开他的工作记录。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { useSwarmStore } from '../../../stores/swarmStore';
import { useComposerStore } from '../../../stores/composerStore';
import { useTeamRecipeStore } from '../../../stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../stores/agentRegistryStore';
import { useI18n } from '../../../hooks/useI18n';
import ipcService from '../../../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import type { SwarmAgentState } from '@shared/contract/swarm';
import type { SwarmRunAgentRecord } from '@shared/contract/swarmTrace';
import { useMemberViewStore } from '../../../stores/memberViewStore';
import { useComposerNoticeStore, selectHasBlockingNotice } from '../../../stores/composerNoticeStore';
import { RoleInitialAvatar } from './RoleInitialAvatar';

export function swarmRunAgentRecordToState(record: SwarmRunAgentRecord): SwarmAgentState {
  return {
    id: record.agentId,
    name: record.name,
    role: record.role,
    status: record.status,
    startTime: record.startTime ?? undefined,
    endTime: record.endTime ?? undefined,
    iterations: 0,
    tokenUsage: { input: record.tokensIn, output: record.tokensOut },
    toolCalls: record.toolCalls,
    error: record.error ?? undefined,
    cost: record.costUsd,
    dispatchedTask: record.dispatchedTask,
    finalOutput: record.finalOutput,
    filesChanged: record.filesChanged,
  };
}

/** 一颗 pill 要渲染的东西；standby=预选待命（没有状态徽标） */
export interface MemberPill {
  key: string;
  roleId: string;
  name: string;
  profession?: string;
  status: 'standby' | 'running' | 'completed' | 'failed';
  agent?: SwarmAgentState;
  record?: SwarmRunAgentRecord;
}

function pillStatusOf(status: SwarmAgentState['status']): MemberPill['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'running';
}

const StatusBadge: React.FC<{ status: MemberPill['status'] }> = ({ status }) => {
  if (status === 'standby') return null;
  if (status === 'running') {
    return <span data-testid="member-status-running" className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-zinc-500 border-t-transparent" />;
  }
  if (status === 'completed') {
    return <span data-testid="member-status-completed" className="shrink-0 text-[11px] leading-none text-emerald-400">✓</span>;
  }
  return <span data-testid="member-status-failed" className="shrink-0 text-[11px] leading-none text-red-400">✕</span>;
};

/**
 * 本会话的团队成员（实时 swarm > 账本回灌 > 预选配方名单）。
 * 成员条和成员对话页共用同一份解析，避免两处各抄一遍口径。
 */
export function useSessionMembers(sessionId: string | null): MemberPill[] {
  const agents = useSwarmStore((state) => state.agents);
  const swarmSessionId = useSwarmStore((state) => state.activeSessionId);
  const selectedTeamRecipeId = useComposerStore((state) => state.selectedTeamRecipeId);
  const recipes = useTeamRecipeStore((state) => state.recipes);
  const agentEntries = useAgentRegistryStore((state) => state.entries);
  const [persistedAgents, setPersistedAgents] = useState<SwarmRunAgentRecord[]>([]);

  const teamAgents = swarmSessionId === sessionId && agents.length > 1 ? agents : [];
  const hasRealtimeTeam = teamAgents.length > 0;

  useEffect(() => {
    let current = true;
    setPersistedAgents([]);
    if (!sessionId || hasRealtimeTeam) return () => { current = false; };
    void ipcService.invoke(IPC_CHANNELS.SWARM_LIST_TRACE_RUNS, { sessionId, limit: 1 })
      .then(async (runs) => {
        const run = runs[0];
        if (!current || !run || run.totalAgents < 2) return;
        const detail = await ipcService.invoke(IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL, { sessionId, runId: run.id });
        if (current && detail?.agents.length && detail.agents.length >= 2) setPersistedAgents(detail.agents);
      })
      .catch(() => { if (current) setPersistedAgents([]); });
    return () => { current = false; };
  }, [hasRealtimeTeam, sessionId]);

  const professionOf = useMemo(() => {
    const map = new Map(agentEntries.map((entry) => [entry.id, entry.profession]));
    return (roleId: string) => map.get(roleId);
  }, [agentEntries]);

  const pills = useMemo<MemberPill[]>(() => {
    const fromAgents = (list: SwarmAgentState[], records?: SwarmRunAgentRecord[]) => list.map((agent, index) => {
      const roleId = agent.role || agent.id;
      return {
        key: agent.id,
        roleId,
        name: agent.name || roleId,
        profession: professionOf(roleId),
        status: pillStatusOf(agent.status),
        agent,
        record: records?.[index],
      } satisfies MemberPill;
    });

    if (hasRealtimeTeam) return fromAgents(teamAgents);
    if (persistedAgents.length > 0) return fromAgents(persistedAgents.map(swarmRunAgentRecordToState), persistedAgents);

    // 预选：还没跑，只铺名单
    const recipe = selectedTeamRecipeId ? recipes.find((item) => item.id === selectedTeamRecipeId) : undefined;
    if (!recipe) return [];
    const roleIds = [...(recipe.lead ? [recipe.lead.roleId] : []), ...recipe.members.map((member) => member.roleId)];
    return roleIds.map((roleId, index) => ({
      key: `${roleId}-${index}`,
      roleId,
      name: roleId,
      profession: professionOf(roleId),
      status: 'standby' as const,
    }));
  }, [hasRealtimeTeam, teamAgents, persistedAgents, selectedTeamRecipeId, recipes, professionOf]);

  return pills;
}

export const SessionMemberBar: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useI18n();
  const text = t.expert.memberBar;
  const pills = useSessionMembers(sessionId);
  const viewingMemberId = useMemberViewStore((state) => state.viewingMemberId);
  const setViewingMemberId = useMemberViewStore((state) => state.setViewingMemberId);
  const blockedByNotice = useComposerNoticeStore(selectHasBlockingNotice);
  const [expandedOverNotice, setExpandedOverNotice] = useState(false);

  // 换会话必须退出成员视图，否则会拿上一个会话的成员去渲染这一个
  useEffect(() => { setViewingMemberId(null); }, [sessionId, setViewingMemberId]);
  // 确认卡收掉后回到常态，别把「展开」黏在下一次
  useEffect(() => { if (!blockedByNotice) setExpandedOverNotice(false); }, [blockedByNotice]);

  if (pills.length === 0) return null;

  const standby = pills[0]?.status === 'standby';

  // 确认卡是阻塞性决策，优先占位；成员条退成一行摘要而不是整条消失
  // （WorkBuddy 的做法是直接吞掉，用户看不到成员也不知道为什么）
  if (blockedByNotice && !expandedOverNotice) {
    const running = pills.filter((pill) => pill.status === 'running').length;
    const summary = standby
      ? text.collapsedStandby.replace('{count}', String(pills.length))
      : running > 0
        ? text.collapsedWorking.replace('{count}', String(running))
        : text.collapsedDone.replace('{count}', String(pills.length));
    return (
      <button /* ds-allow:button: 被确认卡挤掉时的一行摘要，点开恢复完整成员条 */
        type="button"
        data-testid="session-member-bar-collapsed"
        onClick={() => setExpandedOverNotice(true)}
        className="mb-1.5 flex w-full items-center gap-1.5 px-2 text-left text-[11px] text-zinc-500 hover:text-zinc-300"
      >
        <span className="flex -space-x-1.5">
          {pills.slice(0, 4).map((pill) => (
            <RoleInitialAvatar key={pill.key} roleId={pill.roleId} name={pill.name} className="h-4 w-4 border border-zinc-900 text-[8px]" />
          ))}
        </span>
        <span className="truncate">{summary}</span>
        <span aria-hidden>›</span>
      </button>
    );
  }

  return (
    <>
      <div data-testid="session-member-bar" className="mb-2 flex w-full items-center gap-1.5 overflow-x-auto px-2 pb-0.5">
        {!standby && (
          <button /* ds-allow:button: 成员条首位是回主对话的入口，与成员 pill 同构 */
            type="button"
            data-testid="member-pill-leader"
            data-selected={!viewingMemberId}
            onClick={() => setViewingMemberId(null)}
            title={text.leaderTitle}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-left ${
              viewingMemberId ? 'border-zinc-700 bg-zinc-800/70 hover:border-zinc-500' : 'border-zinc-400 bg-zinc-800'
            }`}
          >
            <RoleInitialAvatar roleId="neo" name={text.leader} className="h-5 w-5 text-[10px]" />
            <span className="text-xs font-medium text-zinc-100">{text.leader}</span>
          </button>
        )}
        {pills.map((pill) => (
          <button /* ds-allow:button: 成员 pill 需承载头像、两行文字和状态徽标，Button primitive 的居中按钮形态不适配 */
            key={pill.key}
            type="button"
            data-testid={`member-pill-${pill.roleId}`}
            data-selected={viewingMemberId === pill.key}
            onClick={() => {
              // 待命态还没有对话可看；再点同一个人回主会话
              if (pill.status === 'standby') return;
              setViewingMemberId(viewingMemberId === pill.key ? null : pill.key);
            }}
            title={pill.profession ? `${pill.name} · ${pill.profession}` : pill.name}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-left transition-colors ${
              pill.status === 'standby'
                ? 'border-zinc-800 bg-zinc-900/60 text-zinc-500'
                : viewingMemberId === pill.key
                  ? 'border-zinc-300 bg-zinc-800'
                  : 'border-zinc-700 bg-zinc-800/70 hover:border-zinc-500'
            }`}
          >
            <RoleInitialAvatar roleId={pill.roleId} name={pill.name} className="h-5 w-5 text-[10px]" />
            {/* 职业在上、花名在下：非程序员看「内容主理人」比看「青禾」有用得多 */}
            <span className="flex min-w-0 flex-col items-start leading-tight">
              {pill.profession && <span className="text-xs font-semibold text-zinc-100">{pill.profession}</span>}
              <span className={pill.profession ? 'text-[10px] text-zinc-400' : 'text-xs font-medium text-zinc-100'}>{pill.name}</span>
            </span>
            <StatusBadge status={pill.status} />
          </button>
        ))}
        {standby && <span className="shrink-0 text-[11px] text-zinc-500">{text.standbyHint}</span>}
      </div>
    </>
  );
};
