import React, { useEffect, useState } from 'react';
import { Check, UsersRound, X, Loader2 } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';

export interface TeamRecipeDraftSummary {
  id: string;
  name: string;
  description: string;
  lead?: { roleId: string; briefTemplate: string };
  members: Array<{ id?: string; roleId: string; taskTemplate: string }>;
  unknownRoleNames?: string[];
}

export const TeamRecipeDraftNotifications: React.FC = () => {
  const [drafts, setDrafts] = useState<TeamRecipeDraftSummary[]>([]);
  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: { type: string; data: unknown }) => {
      if (event.type !== 'team_recipe_draft_pending' || !event.data) return;
      const incoming = (event.data as { drafts?: TeamRecipeDraftSummary[] }).drafts;
      if (!Array.isArray(incoming)) return;
      setDrafts((current) => [...current.filter((draft) => !incoming.some((item) => item.id === draft.id)), ...incoming]);
    });
    return () => { unsubscribe?.(); };
  }, []);
  return drafts.length ? <TeamRecipeDraftCard drafts={drafts} onResolved={(id) => setDrafts((current) => current.filter((draft) => draft.id !== id))} onDismiss={() => setDrafts([])} /> : null;
};

export const TeamRecipeDraftCard: React.FC<{ drafts: TeamRecipeDraftSummary[]; onResolved: (id: string) => void; onDismiss: () => void }> = ({ drafts, onResolved, onDismiss }) => {
  const { t } = useI18n();
  const text = t.team;
  const [busyId, setBusyId] = useState<string | null>(null);
  const process = async (draftId: string, action: 'confirmDraft' | 'rejectDraft') => {
    setBusyId(draftId);
    try {
      const result = await ipcService.invokeDomain<{ success?: boolean }>(IPC_DOMAINS.TEAM, action, { draftId });
      if (result?.success) {
        onResolved(draftId);
        toast.success(action === 'confirmDraft' ? text.draftSaved : text.draftDiscarded);
      } else toast.error(text.draftProcessFailed);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : text.draftProcessFailed);
    } finally { setBusyId(null); }
  };
  return <div className="px-3 py-2 mb-2 bg-violet-500/10 border border-violet-500/20 rounded-lg animate-fadeIn" data-testid="team-recipe-draft-card">
    <div className="flex items-center gap-2 mb-1"><UsersRound className="w-4 h-4 text-violet-300" /><span className="text-xs text-violet-200 flex-1">{text.draftPendingBanner}</span><button /* ds-allow:button: 草稿卡关闭是图标级瞬时操作 */ type="button" onClick={onDismiss} title={text.draftLater} className="p-0.5 text-zinc-500 hover:text-zinc-300"><X className="w-3.5 h-3.5" /></button></div>
    {drafts.map((draft) => <div key={draft.id} className="py-1.5 border-t border-violet-500/10 first:border-t-0">
      <div className="text-xs font-medium text-violet-100">{draft.name}</div>
      <div className="text-[11px] text-violet-200/70">{draft.lead ? text.draftExpertTeam.replace('{lead}', draft.lead.roleId) : text.draftExpertGroup}</div>
      {draft.lead ? <div className="text-[11px] text-zinc-400">{draft.lead.briefTemplate}</div> : null}
      <div className="mt-1 text-[11px] text-zinc-300">{text.draftMembers}</div>
      <ul className="text-[11px] text-zinc-400 list-disc pl-4">{draft.members.map((member, index) => <li key={`${member.id ?? member.roleId}-${index}`}><span className="text-zinc-300">{member.roleId}</span>：{member.taskTemplate}</li>)}</ul>
      {draft.unknownRoleNames?.length ? <div className="mt-1 text-[11px] text-amber-300" role="alert">{text.draftUnknownRoles.replace('{roles}', draft.unknownRoleNames.join('、'))} {text.draftUnknownActions}</div> : null}
      <div className="mt-2 flex gap-2"><button /* ds-allow:button: 草稿确认需在卡内与放弃并列呈现 */ type="button" disabled={busyId !== null} onClick={() => void process(draft.id, 'confirmDraft')} className="flex items-center gap-1 px-2 py-1 text-xs bg-violet-500/20 text-violet-200 rounded disabled:opacity-50">{busyId === draft.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}{text.draftConfirm}</button><button /* ds-allow:button: 草稿放弃与确认构成同一行紧凑决策 */ type="button" disabled={busyId !== null} onClick={() => void process(draft.id, 'rejectDraft')} className="px-2 py-1 text-xs text-zinc-400 rounded disabled:opacity-50">{text.draftReject}</button></div>
    </div>)}
  </div>;
};
