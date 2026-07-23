import React, { useEffect, useState } from 'react';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSwarmStore } from '../../../stores/swarmStore';
import { useI18n } from '../../../hooks/useI18n';
import { listRoles } from '../../../services/rolesClient';
import ipcService from '../../../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import type { SwarmAgentState } from '@shared/contract/swarm';
import type { SwarmRunAgentRecord, SwarmRunStatus } from '@shared/contract/swarmTrace';
import { RoleInitialAvatar } from './RoleInitialAvatar';
import { AgentWorkRecordDialog } from '../swarm/AgentWorkRecordDialog';

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

export const SessionAgentIdentityBar: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const activeAgentId = useAppStore((state) => state.activeAgentId);
  const openExpertRoleDetail = useAppStore((state) => state.openExpertRoleDetail);
  const agents = useSwarmStore((state) => state.agents);
  const swarmSessionId = useSwarmStore((state) => state.activeSessionId);
  const sessionTitle = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId)?.title);
  const { t } = useI18n();
  const [entry, setEntry] = useState<RolePanelEntry | null>(null);
  const [persistedAgents, setPersistedAgents] = useState<SwarmRunAgentRecord[]>([]);
  const [persistedRunStatus, setPersistedRunStatus] = useState<SwarmRunStatus | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<SwarmAgentState | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<SwarmRunAgentRecord | null>(null);

  useEffect(() => {
    let current = true;
    if (!sessionId || !activeAgentId) {
      setEntry(null);
      return () => { current = false; };
    }
    void listRoles().then((roles) => {
      if (current) setEntry(roles.find((role) => role.roleId === activeAgentId) ?? null);
    }).catch(() => { if (current) setEntry(null); });
    return () => { current = false; };
  }, [activeAgentId, sessionId]);

  const teamAgents = swarmSessionId === sessionId && agents.length > 1 ? agents : [];
  const hasRealtimeTeam = teamAgents.length > 0;

  useEffect(() => {
    let current = true;
    if (!sessionId || hasRealtimeTeam) {
      setPersistedAgents([]);
      setPersistedRunStatus(null);
      return () => { current = false; };
    }
    setPersistedAgents([]);
    setPersistedRunStatus(null);
    void ipcService.invoke(IPC_CHANNELS.SWARM_LIST_TRACE_RUNS, { sessionId, limit: 1 })
      .then(async (runs) => {
        const run = runs[0];
        if (!current || !run || run.totalAgents < 2) return;
        const detail = await ipcService.invoke(IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL, { sessionId, runId: run.id });
        if (current) {
          setPersistedAgents(detail?.agents.length && detail.agents.length >= 2 ? detail.agents : []);
          setPersistedRunStatus(detail?.agents.length && detail.agents.length >= 2 ? run.status : null);
        }
      })
      .catch(() => {
        if (current) {
          setPersistedAgents([]);
          setPersistedRunStatus(null);
        }
      });
    return () => { current = false; };
  }, [hasRealtimeTeam, sessionId]);

  const displayedAgents = hasRealtimeTeam ? teamAgents : persistedAgents.map(swarmRunAgentRecordToState);
  const openWorkRecord = (agent: SwarmAgentState, record: SwarmRunAgentRecord | null = null) => {
    setSelectedAgent(agent);
    setSelectedRecord(record);
  };

  if (displayedAgents.length > 0) {
    const completed = hasRealtimeTeam
      ? displayedAgents.every((agent) => agent.status === 'completed')
      : persistedRunStatus === 'completed';
    return (
      <>
        <div data-testid="session-team-identity" className="mx-4 mt-2 flex items-center gap-2 self-start rounded-lg border border-violet-900/60 bg-violet-950/20 px-2.5 py-1.5">
          <span className="text-xs font-medium text-zinc-100">{sessionTitle || t.expert.sessionIdentity.team}</span>
          <span className="flex -space-x-1.5">
            {displayedAgents.map((agent, index) => <button /* ds-allow:button: 团队身份条头像需提供稳定的成员工作记录入口 */ key={agent.id} type="button" onClick={() => openWorkRecord(agent, hasRealtimeTeam ? null : persistedAgents[index])} className="relative rounded-full transition-transform hover:z-10 hover:scale-110" title={agent.name || agent.role}><RoleInitialAvatar roleId={agent.role || agent.id} name={agent.name || agent.role} className="h-6 w-6 border border-zinc-900 text-[10px]" /></button>)}
          </span>
          <span className="text-[11px] text-zinc-400">{completed ? t.expert.sessionIdentity.completed : t.expert.sessionIdentity.working}</span>
        </div>
        {selectedAgent ? <AgentWorkRecordDialog agent={selectedAgent} record={selectedRecord} onBack={() => setSelectedAgent(null)} /> : null}
      </>
    );
  }
  if (!entry) return null;
  const name = entry.displayName || entry.roleId;
  return (
    <button /* ds-allow:button: 会话身份条整行进入专家详情，需保留紧凑行布局 */
      type="button"
      data-testid="session-agent-identity"
      onClick={() => openExpertRoleDetail(entry.roleId)}
      className="mx-4 mt-2 flex items-center gap-2 self-start rounded-lg border border-violet-900/60 bg-violet-950/20 px-2.5 py-1.5 text-left transition-colors hover:bg-violet-950/40"
    >
      <RoleInitialAvatar roleId={entry.roleId} name={name} />
      <span className="min-w-0"><span className="block text-xs font-medium text-zinc-100">{name}</span><span className="block text-[11px] text-zinc-400">{entry.profession || t.expert.professionFallback}</span></span>
    </button>
  );
};
