// ============================================================================
// SessionMemberBar - 输入框正上方的折叠 chip（N-L6-AGENTVIEW S1）
// ============================================================================
// 两种数据源，同一条：
//   1) 预选：用户在「＋ → 团队」选了配方但还没发第一句话 —— 灰态名单，让他先知道
//      这个团队由谁组成（WorkBuddy 不做这一步，只在真 spawn 后才铺；我们多给一层可预期性）
//   2) 运行时：会话真的跑起来了（持久化账本/API 回灌）—— 带状态
// 08-22 拍板：常态只渲染一条折叠 chip「N 个代理工作中 · 当前一句」+ 尾部「合没合」
// 总账 +「›」，不再有 pill 展开态；点 chip 直达右侧「专家」一级页签，
// 停止全部 / token / 成员 pill 都留在原专家内容面板。
// ============================================================================

import React, { useEffect, useMemo } from 'react';
import { Bot } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useComposerStore } from '../../../stores/composerStore';
import { useTeamRecipeStore } from '../../../stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../stores/agentRegistryStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import type { SwarmAgentState } from '@shared/contract/swarm';
import type { SwarmRunAgentRecord } from '@shared/contract/swarmTrace';
import { readPersistedTeamLead, teamRecipeMemberKey } from '@shared/contract/teamRecipe';
import { useMemberViewStore } from '../../../stores/memberViewStore';
import { RoleInitialAvatar } from './RoleInitialAvatar';
import { useDurableSwarmRunDetail } from '../../../hooks/useDurableSwarmRunDetail';
import { useSessionAgentRows } from '../../../hooks/useSessionAgentRows';
import { deriveAgentMergeState } from '../../../utils/agentMergeState';
import type { AgentRow } from '../../../utils/agentRows';
import { useRightPanelTabsStore } from '../../../stores/rightPanelTabsStore';

/** 打开右侧「专家」一级页签。 */
function openSessionAgentsPanel(sessionId: string | null): void {
  if (sessionId) useRightPanelTabsStore.getState().setExpertsDismissed(sessionId, false);
  useAppStore.getState().openWorkbenchTab('experts', { source: 'user' });
}

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
  /** 角色 lucide 图标名（与 profession 同取自 agentRegistry entries）：头像 asset → icon → 首字 三级回落的中间档 */
  icon?: string;
  status: 'standby' | 'running' | 'completed' | 'failed';
  isLead: boolean;
  /** standby 成员的排除键（member 的 id ?? roleId；lead 用 roleId），× 掉时写进 composerStore */
  standbyKey?: string;
  agent?: SwarmAgentState;
  record?: SwarmRunAgentRecord;
}

function pillStatusOf(status: SwarmAgentState['status']): MemberPill['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'running';
}

/**
 * 本会话的团队成员（持久化账本/API > 预选配方名单）。
 * 成员条和成员对话页共用同一份解析，避免两处各抄一遍口径。
 */
export function useSessionMembers(sessionId: string | null): MemberPill[] {
  const selectedTeamRecipeId = useComposerStore((state) => state.selectedTeamRecipeId);
  const standbyExcludedMemberKeys = useComposerStore((state) => state.standbyExcludedMemberKeys);
  const recipes = useTeamRecipeStore((state) => state.recipes);
  const agentEntries = useAgentRegistryStore((state) => state.entries);
  const teamLeadRoleId = useSessionStore((state) => {
    const session = state.sessions.find((item) => item.id === sessionId);
    return readPersistedTeamLead(session?.metadata)?.roleId ?? null;
  });
  const durableDetail = useDurableSwarmRunDetail(sessionId);
  // 账本必须自证属于本会话再采信。原先靠「至少 2 个成员」间接挡住外会话的 run
  // （单 agent 的陈旧 run 挤进来会把别人的成员画到这条上，e2e 实测过：
  // swarm-chain 的 e2e-scout 出现在 workbench-overview 新建的会话里）。
  // 单发后台 agent 也要进成员条，数量门槛就挡不住了 —— 改用 sessionId 硬校验，
  // 既放行单发，又把跨会话泄漏堵死在数据自证这一层。
  const persistedAgents = durableDetail?.agents.length
    && durableDetail.run.sessionId === sessionId
    ? durableDetail.agents
    : [];

  const professionOf = useMemo(() => {
    const map = new Map(agentEntries.map((entry) => [entry.id, entry.profession]));
    return (roleId: string) => map.get(roleId);
  }, [agentEntries]);

  // 与 professionOf 同源：角色 icon（lucide 名）供成员条头像三级回落的中间档
  const iconOf = useMemo(() => {
    const map = new Map(agentEntries.map((entry) => [entry.id, entry.icon]));
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
        icon: iconOf(roleId),
        status: pillStatusOf(agent.status),
        isLead: roleId === teamLeadRoleId,
        agent,
        record: records?.[index],
      } satisfies MemberPill;
    });

    if (persistedAgents.length > 0) return fromAgents(persistedAgents.map(swarmRunAgentRecordToState), persistedAgents);

    // 预选：还没跑，只铺名单（× 掉的成员按 standbyExcludedMemberKeys 过滤，
    // 发送启动时同一份排除会传给 host，显示口径 = 实际起团口径）
    const recipe = selectedTeamRecipeId ? recipes.find((item) => item.id === selectedTeamRecipeId) : undefined;
    if (!recipe) return [];
    const standbyEntries = [
      ...(recipe.lead ? [{ roleId: recipe.lead.roleId, standbyKey: recipe.lead.roleId }] : []),
      ...recipe.members.map((member) => ({ roleId: member.roleId, standbyKey: teamRecipeMemberKey(member) })),
    ];
    return standbyEntries
      .filter((entry) => !standbyExcludedMemberKeys.includes(entry.standbyKey))
      .map((entry, index) => ({
        key: `${entry.roleId}-${index}`,
        roleId: entry.roleId,
        name: entry.roleId,
        profession: professionOf(entry.roleId),
        icon: iconOf(entry.roleId),
        status: 'standby' as const,
        isLead: entry.roleId === teamLeadRoleId,
        standbyKey: entry.standbyKey,
      }));
  }, [persistedAgents, selectedTeamRecipeId, standbyExcludedMemberKeys, recipes, professionOf, iconOf, teamLeadRoleId]);

  return pills;
}

/** chip 左侧头像叠：专家用角色头像三级回落，普通代理/后台任务一律 lucide Bot（08-22 拍板）。 */
const ChipAvatar: React.FC<{ row: AgentRow }> = ({ row }) => {
  if (row.kind === 'expert') {
    return (
      <RoleInitialAvatar
        roleId={row.roleId ?? row.name}
        name={row.name}
        icon={row.icon}
        className="h-4 w-4 border border-zinc-900 text-[8px]"
      />
    );
  }
  return (
    <span className="flex h-4 w-4 items-center justify-center rounded-full border border-zinc-900 bg-zinc-800 text-zinc-400">
      <Bot className="h-2.5 w-2.5" aria-hidden />
    </span>
  );
};

export const SessionMemberBar: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useI18n();
  const text = t.expert.memberBar;
  const setViewingMemberId = useMemberViewStore((state) => state.setViewingMemberId);
  const { rows, conflicts } = useSessionAgentRows(sessionId);

  // 换会话必须退出成员视图，否则会拿上一个会话的成员去渲染这一个
  useEffect(() => { setViewingMemberId(null); }, [sessionId, setViewingMemberId]);

  const standby = rows.length > 0 && rows.every((row) => row.status === 'standby');
  const working = rows.filter((row) => row.status === 'working');
  const mergeState = standby ? null : deriveAgentMergeState(rows, conflicts);

  if (rows.length === 0) return null;

  // 「N 个代理工作中 · 当前一句」：当前一句 = 第一个 running 代理的最近工具步人话
  const firstWorking = working[0];
  const summary = standby
    ? text.collapsedStandby.replace('{count}', String(rows.length))
    : firstWorking
      ? `${text.collapsedWorking.replace('{count}', String(working.length))} · ${firstWorking.name} ${firstWorking.activity ?? ''}`
      : text.collapsedDone.replace('{count}', String(rows.length));
  const mergeLabel = mergeState === 'merged'
    ? text.mergeState.chipMerged
    : mergeState === 'conflict'
      ? text.mergeState.chipConflict.replace('{count}', String(conflicts.length))
      : mergeState === 'waiting'
        ? text.mergeState.chipWaiting
        : null;

  return (
    <button /* ds-allow:button: 折叠 chip 是整行摘要入口（头像叠+两行信息），Button primitive 无此形态 */
      type="button"
      data-testid="session-member-bar-collapsed"
      onClick={() => openSessionAgentsPanel(sessionId)}
      className="mb-1.5 flex w-full items-center gap-1.5 px-2 text-left text-[11px] text-zinc-500 hover:text-zinc-300"
    >
      <span className="flex -space-x-1.5">
        {rows.slice(0, 4).map((row) => <ChipAvatar key={row.key} row={row} />)}
      </span>
      <span className="truncate">{summary}</span>
      {mergeLabel && (
        <span data-testid="member-bar-merge-state" className="ml-auto shrink-0 pl-2 text-zinc-400">
          {mergeLabel}
        </span>
      )}
      <span aria-hidden>›</span>
    </button>
  );
};
