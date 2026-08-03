// ============================================================================
// SessionMemberBar - 输入框正上方的团队成员条
// ============================================================================
// 两种数据源，同一条：
//   1) 预选：用户在「＋ → 团队」选了配方但还没发第一句话 —— 灰态名单，让他先知道
//      这个团队由谁组成（WorkBuddy 不做这一步，只在真 spawn 后才铺；我们多给一层可预期性）
//   2) 运行时：会话真的跑起来了（持久化账本/API 回灌）—— 带状态
// 第一颗 pill 永远是「主会话」（团长位），点它回主对话；点成员打开他的工作记录。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useSwarmStore } from '../../../stores/swarmStore';
import { useComposerStore } from '../../../stores/composerStore';
import { useTeamRecipeStore } from '../../../stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../stores/agentRegistryStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import type { SwarmAgentState } from '@shared/contract/swarm';
import type { SwarmRunAgentRecord } from '@shared/contract/swarmTrace';
import { readPersistedTeamLead, teamRecipeMemberKey } from '@shared/contract/teamRecipe';
import { useMemberViewStore } from '../../../stores/memberViewStore';
import { useComposerNoticeStore, selectHasBlockingNotice } from '../../../stores/composerNoticeStore';
import { useVoiceCallStore } from '../../../stores/voiceCallStore';
import { RoleInitialAvatar } from './RoleInitialAvatar';
import { useDurableSwarmRunDetail } from '../../../hooks/useDurableSwarmRunDetail';

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

const StatusBadge: React.FC<{ status: MemberPill['status'] }> = ({ status }) => {
  if (status === 'standby') return null;
  if (status === 'running') {
    return <span data-testid="member-status-running" className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-zinc-500 border-t-transparent" />;
  }
  if (status === 'completed') {
    return <span data-testid="member-status-completed" className="shrink-0 text-[11px] leading-none text-badge-success">✓</span>;
  }
  return <span data-testid="member-status-failed" className="shrink-0 text-[11px] leading-none text-badge-danger">✕</span>;
};

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
  const persistedAgents = durableDetail?.agents.length && durableDetail.agents.length >= 2
    ? durableDetail.agents
    : [];

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
        status: 'standby' as const,
        isLead: entry.roleId === teamLeadRoleId,
        standbyKey: entry.standbyKey,
      }));
  }, [persistedAgents, selectedTeamRecipeId, standbyExcludedMemberKeys, recipes, professionOf, teamLeadRoleId]);

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
  // 通话中高亮通话身份（§6.7.7；只展示，点击切换 set_active_agent 是 Phase 2）
  const voiceCallLive = useVoiceCallStore((state) => state.phase === 'live' || state.phase === 'connecting');
  const voiceActiveAgentId = useVoiceCallStore((state) => state.activeAgentId);

  // 换会话必须退出成员视图，否则会拿上一个会话的成员去渲染这一个
  useEffect(() => { setViewingMemberId(null); }, [sessionId, setViewingMemberId]);
  // 确认卡收掉后回到常态，别把「展开」黏在下一次
  useEffect(() => { if (!blockedByNotice) setExpandedOverNotice(false); }, [blockedByNotice]);

  // standby ×：把该成员从本次预选排除（启动时少起这个人）；
  // × 到最后一个不剩 = 整团取消，清掉配方预选本身（排除标记随 setSelectedTeamRecipeId 一并复位）
  const removeStandbyMember = (pill: MemberPill) => {
    if (!pill.standbyKey) return;
    const store = useComposerStore.getState();
    const remaining = pills.filter((candidate) => candidate.standbyKey !== pill.standbyKey);
    if (remaining.length === 0) {
      store.setSelectedTeamRecipeId(null);
      return;
    }
    store.setStandbyExcludedMemberKeys([...store.standbyExcludedMemberKeys, pill.standbyKey]);
  };

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
        {pills.map((pill) => {
          const voiceActive = voiceCallLive && (pill.key === voiceActiveAgentId || pill.roleId === voiceActiveAgentId);
          // standby pill 本体点击是无操作（还没有对话可看），语义保持；
          // 取消预选走 hover 浮现的 × 按钮或聚焦后 Delete/Backspace，与 composer chip 口径一致
          if (pill.status === 'standby') {
            return (
              <div
                key={pill.key}
                role="group"
                tabIndex={0}
                data-testid={`member-pill-${pill.roleId}`}
                data-voice-active={voiceActive || undefined}
                title={pill.profession ? `${pill.name} · ${pill.profession}` : pill.name}
                aria-label={pill.name}
                onKeyDown={(event) => {
                  if (event.key !== 'Delete' && event.key !== 'Backspace') return;
                  event.preventDefault();
                  removeStandbyMember(pill);
                }}
                className="group flex shrink-0 cursor-default items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/60 py-1 pl-1 pr-2.5 text-left text-zinc-500 transition-colors"
              >
                <RoleInitialAvatar roleId={pill.roleId} name={pill.name} className="h-5 w-5 text-[10px]" />
                <span className="flex min-w-0 flex-col items-start leading-tight">
                  {pill.profession && <span className="text-xs font-semibold text-zinc-100">{pill.profession}</span>}
                  <span className={pill.profession ? 'text-[10px] text-zinc-400' : 'text-xs font-medium text-zinc-100'}>{pill.name}</span>
                </span>
                {pill.isLead && (
                  <span
                    data-testid={`member-lead-badge-${pill.roleId}`}
                    className="shrink-0 rounded bg-amber-400/15 px-1 py-0.5 text-[9px] font-medium leading-none text-amber-300"
                  >
                    {text.leadLabel}
                  </span>
                )}
                <button /* ds-allow:button: standby 成员 pill 的删除是图标级小按钮，Button primitive 无此紧凑图标变体 */
                  type="button"
                  tabIndex={-1}
                  data-testid={`member-standby-remove-${pill.roleId}`}
                  onClick={() => removeStandbyMember(pill)}
                  aria-label={text.standbyRemoveAria.replace('{name}', pill.name)}
                  className="-mr-1 shrink-0 rounded-full p-0.5 text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </div>
            );
          }
          return (
          <button /* ds-allow:button: 成员 pill 需承载头像、两行文字和状态徽标，Button primitive 的居中按钮形态不适配 */
            key={pill.key}
            type="button"
            data-testid={`member-pill-${pill.roleId}`}
            data-selected={viewingMemberId === pill.key}
            data-voice-active={voiceActive || undefined}
            onClick={() => {
              // 再点同一个人回主会话（standby 走上方 div 分支，不会到这里）
              setViewingMemberId(viewingMemberId === pill.key ? null : pill.key);
            }}
            title={pill.profession ? `${pill.name} · ${pill.profession}` : pill.name}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-left transition-colors ${
              voiceActive
                ? 'border-badge-success/70 bg-emerald-500/10 ring-1 ring-emerald-400/40'
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
            {pill.isLead && (
              <span
                data-testid={`member-lead-badge-${pill.roleId}`}
                className="shrink-0 rounded bg-amber-400/15 px-1 py-0.5 text-[9px] font-medium leading-none text-amber-300"
              >
                {text.leadLabel}
              </span>
            )}
            <StatusBadge status={pill.status} />
          </button>
          );
        })}
        {standby && <span className="shrink-0 text-[11px] text-zinc-500">{text.standbyHint}</span>}
      </div>
    </>
  );
};
