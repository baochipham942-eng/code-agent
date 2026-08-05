// ============================================================================
// MemberConversationView - 单个团队成员的对话页
// ============================================================================
// 从成员条点进来，聊天区整块换成这位成员的对话：团长下发给他的任务（用户位气泡）
// → 运行中他和团队之间的过程消息 → 他回传的产出。
// 只读：人只跟团长说话，不跟成员说话，所以输入框被「回主会话」覆盖层挡住
// （覆盖层在 ChatInput 侧，不在这里）。
// ============================================================================

import React, { useMemo } from 'react';
import { Clock, Wrench, Zap } from 'lucide-react';
import { useSwarmStore } from '../../../stores/swarmStore';
import { useMemberViewStore } from '../../../stores/memberViewStore';
import { useDurableSwarmRunDetail } from '../../../hooks/useDurableSwarmRunDetail';
import { useI18n } from '../../../hooks/useI18n';
import { humanizeToolStep } from '../../../utils/humanizeToolStep';
import { RoleInitialAvatar } from './RoleInitialAvatar';
import { useSessionMembers } from './SessionMemberBar';

/** 轨迹只回看最近这几条：成员视图是「他现在在干嘛」，不是全量审计日志。 */
const RUN_TRAIL_LIMIT = 12;

function durationLabel(ms?: number | null): string {
  if (!ms) return '—';
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const MemberConversationView: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useI18n();
  const text = t.expert.workRecord;
  const memberText = t.expert.memberBar;
  const viewingMemberId = useMemberViewStore((state) => state.viewingMemberId);
  const messages = useSwarmStore((state) => state.messages);
  const members = useSessionMembers(sessionId);
  const durableDetail = useDurableSwarmRunDetail(sessionId);

  const member = members.find((item) => item.key === viewingMemberId);
  const agent = member?.agent;
  // useSessionMembers 以持久化账本为状态真相源，而 contextSnapshot 只活在 stream 里
  // （账本不落它）。最近动作要的是「他此刻在干嘛」，所以这一项单独从 store 取实时的。
  const liveContextSnapshot = useSwarmStore((state) => (
    viewingMemberId
      ? state.agents.find((item) => item.id === viewingMemberId)?.contextSnapshot
      : undefined
  ));

  // 过程消息只在运行中存在（账本只落任务和产出），取不到就只显示首尾两段
  const memberMessages = useMemo(() => {
    if (!agent) return [];
    const names = new Set([agent.id, agent.name, agent.role].filter(Boolean) as string[]);
    return messages.filter((message) => names.has(message.from) || names.has(message.to));
  }, [messages, agent]);

  // D2 最近动作：contextSnapshot.tools 是执行器每轮真实用过的工具名（去重后最近 6 个），
  // 经 task:progress → agentUpdated 一路活着送到 store。工具名对非程序员没意义，
  // 过一遍聊天流那套 humanizeToolStep；没有 args 时它落到各类目的人话兜底句。
  const recentActions = useMemo(() => {
    const tools = (liveContextSnapshot ?? agent?.contextSnapshot)?.tools ?? [];
    return [...tools].reverse().map((tool, index) => ({
      key: `${tool}-${index}`,
      label: humanizeToolStep(tool, undefined, t),
    }));
  }, [liveContextSnapshot, agent?.contextSnapshot, t]);

  // D2 运行轨迹：粗粒度生命周期事件早就落库（SwarmRunEventRecord），此前全仓零消费。
  // 只取这位成员的 + 不挂具体成员的 run 级事件，倒序滚动。
  const runTrail = useMemo(() => {
    const events = durableDetail?.events ?? [];
    return events
      .filter((event) => !event.agentId || event.agentId === agent?.id)
      .slice(-RUN_TRAIL_LIMIT)
      .reverse();
  }, [durableDetail?.events, agent?.id]);

  if (!member || !agent) return null;

  const tokens = (agent.tokenUsage?.input ?? 0) + (agent.tokenUsage?.output ?? 0);
  const elapsed = agent.startTime ? (agent.endTime ?? Date.now()) - agent.startTime : null;

  return (
    <div data-testid="member-conversation-view" className="flex-1 overflow-y-auto px-4 py-4">
      <header className="mx-auto flex max-w-3xl items-center gap-3 border-b border-zinc-800 pb-3">
        <RoleInitialAvatar roleId={member.roleId} name={member.name} className="h-8 w-8 text-xs" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-zinc-100">{member.profession || member.name}</h2>
          <p className="truncate text-xs text-zinc-400">{member.profession ? member.name : member.roleId}</p>
        </div>
        <span className="shrink-0 text-[11px] text-zinc-500">{memberText.readOnlyHint}</span>
      </header>

      <div className="mx-auto max-w-3xl space-y-4 py-4 text-sm">
        <section data-testid="member-dispatched-task">
          <h3 className="mb-1 text-xs font-medium text-zinc-400">{text.receivedTask}</h3>
          <div className="rounded-lg bg-zinc-950/60 px-3 py-2 text-xs leading-relaxed text-zinc-300">
            {agent.dispatchedTask || text.noTask}
          </div>
        </section>

        {/* 过程可见（D2）：不再是「下发任务 → 黑箱 → 终局产出」，中间这段能滚动看见 */}
        <section data-testid="member-recent-actions">
          <h3 className="mb-1 text-xs font-medium text-zinc-400">{memberText.recentActions}</h3>
          {recentActions.length === 0 ? (
            <p className="text-xs text-zinc-500">{memberText.noRecentActions}</p>
          ) : (
            <ul className="space-y-1">
              {recentActions.map((action) => (
                <li
                  key={action.key}
                  data-testid="member-recent-action"
                  className="truncate rounded-md bg-zinc-950/40 px-3 py-1.5 text-xs text-zinc-300"
                >
                  {action.label}
                </li>
              ))}
            </ul>
          )}
        </section>

        {runTrail.length > 0 && (
          <section data-testid="member-run-trail">
            <h3 className="mb-1 text-xs font-medium text-zinc-400">{memberText.runTrail}</h3>
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {runTrail.map((event) => (
                <li
                  key={event.id}
                  data-testid="member-run-trail-event"
                  className="rounded-md bg-zinc-950/40 px-3 py-1.5 text-xs text-zinc-400"
                >
                  <span className="mr-2 font-mono text-[10px] text-zinc-500">{timeLabel(event.timestamp)}</span>
                  <span className="text-zinc-300">{event.title}</span>
                  {event.summary && event.summary !== event.title && (
                    <p className="mt-0.5 truncate text-[11px] text-zinc-500">{event.summary}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {memberMessages.length > 0 && (
          <section data-testid="member-process-messages">
            <h3 className="mb-1 text-xs font-medium text-zinc-400">{memberText.processMessages}</h3>
            <ul className="space-y-1.5">
              {memberMessages.map((message) => (
                <li key={message.id} className="rounded-lg bg-zinc-950/40 px-3 py-2 text-xs leading-relaxed text-zinc-400">
                  <span className="text-zinc-500">{message.from} → {message.to}</span>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-zinc-300">{message.content}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section data-testid="member-final-output">
          <h3 className="mb-1 text-xs font-medium text-zinc-400">{text.output}</h3>
          <div className="rounded-lg bg-zinc-950/60 px-3 py-2 text-xs leading-relaxed text-zinc-300">
            <pre className="whitespace-pre-wrap break-words font-sans text-zinc-200">{agent.finalOutput || text.noOutput}</pre>
          </div>
        </section>

        <section data-testid="member-usage" className="flex items-center gap-3 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1"><Wrench className="h-3.5 w-3.5" />{text.tools.replace('{count}', String(agent.toolCalls ?? 0))}</span>
          <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{durationLabel(elapsed)}</span>
          <span className="inline-flex items-center gap-1"><Zap className="h-3.5 w-3.5" />{tokens}</span>
          <span>${(agent.cost ?? 0).toFixed(4)}</span>
        </section>
      </div>
    </div>
  );
};
