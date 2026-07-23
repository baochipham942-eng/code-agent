import React, { useEffect, useState } from 'react';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSwarmStore } from '../../../stores/swarmStore';
import { useI18n } from '../../../hooks/useI18n';
import { listRoles } from '../../../services/rolesClient';
import { RoleInitialAvatar } from './RoleInitialAvatar';

export const SessionAgentIdentityBar: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const activeAgentId = useAppStore((state) => state.activeAgentId);
  const openExpertRoleDetail = useAppStore((state) => state.openExpertRoleDetail);
  const agents = useSwarmStore((state) => state.agents);
  const swarmSessionId = useSwarmStore((state) => state.activeSessionId);
  const sessionTitle = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId)?.title);
  const { t } = useI18n();
  const [entry, setEntry] = useState<RolePanelEntry | null>(null);

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
  if (teamAgents.length > 0) {
    return (
      <div data-testid="session-team-identity" className="mx-4 mt-2 flex items-center gap-2 self-start rounded-lg border border-violet-900/60 bg-violet-950/20 px-2.5 py-1.5">
        <span className="text-xs font-medium text-zinc-100">{sessionTitle || t.expert.sessionIdentity.team}</span>
        <span className="flex -space-x-1.5">
          {teamAgents.map((agent) => <RoleInitialAvatar key={agent.id} roleId={agent.role || agent.id} name={agent.name || agent.role} className="h-6 w-6 border border-zinc-900 text-[10px]" />)}
        </span>
        <span className="text-[11px] text-zinc-400">{teamAgents.every((agent) => agent.status === 'completed') ? t.expert.sessionIdentity.completed : t.expert.sessionIdentity.working}</span>
      </div>
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
