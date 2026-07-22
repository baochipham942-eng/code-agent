import React, { useEffect, useState } from 'react';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import type { TeamRecipe, TeamRecipeMember } from '@shared/contract/teamRecipe';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import type { SkillCategory } from '@shared/contract/skillRepository';
import { Button } from '../../primitives/Button';
import { SettingsSection } from '../settings/SettingsLayout';
import { useI18n } from '../../../hooks/useI18n';
import { updateTeamRecipe, type TeamRecipeWrite } from '../../../services/teamRecipeClient';

const CATEGORIES: SkillCategory[] = ['docs-office', 'data-analysis', 'design-creative', 'content-marketing', 'product', 'research', 'automation', 'development'];

function writeFrom(recipe: TeamRecipe): TeamRecipeWrite {
  return {
    name: recipe.name,
    description: recipe.description,
    category: recipe.category,
    members: recipe.members.map((member) => ({ ...member, dependsOn: undefined })),
    lead: recipe.lead ? { ...recipe.lead } : undefined,
    tags: recipe.tags,
  };
}

interface Props {
  recipe: TeamRecipe;
  entries: RolePanelEntry[];
  editable: boolean;
  onBack: () => void;
  onCopied: (recipe: TeamRecipe) => void;
  onSaved: (recipe: TeamRecipe) => void;
}

export const TeamRecipeDetailPage: React.FC<Props> = ({ recipe, entries, editable, onBack, onCopied, onSaved }) => {
  const { t } = useI18n();
  const text = t.team;
  const [draft, setDraft] = useState<TeamRecipeWrite>(() => writeFrom(recipe));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 提出来给 JSX 用：闭包里 TS 收窄不到 draft.lead，直接引用会逼出非空断言（棘轮 +1）
  const lead = draft.lead;

  useEffect(() => {
    setDraft(writeFrom(recipe));
    setError(null);
  }, [recipe]);

  const roleName = (roleId: string) => entries.find((entry) => entry.roleId === roleId)?.displayName || roleId;
  const updateMember = (index: number, patch: Partial<TeamRecipeMember>) => {
    setDraft((current) => ({ ...current, members: current.members.map((member, memberIndex) => memberIndex === index ? { ...member, ...patch } : member) }));
  };
  const addMember = () => {
    if (draft.members.length >= 5) {
      setError(text.memberLimit);
      return;
    }
    setDraft((current) => ({ ...current, members: [...current.members, { roleId: entries[0]?.roleId ?? '', taskTemplate: '' }] }));
  };
  const save = async () => {
    if (draft.members.length > 5) {
      setError(text.memberLimit);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await updateTeamRecipe(recipe.id, draft);
      onSaved(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5" data-testid={`team-recipe-detail-${recipe.id}`}>
      <button /* ds-allow:button: 配方详情返回是无背景的文字链接，Button primitive 会改变页面层级 */ type="button" onClick={onBack} className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200">
        <ArrowLeft className="h-3.5 w-3.5" />{text.back}
      </button>
      <header className="flex items-start justify-between gap-3">
        <div><h3 className="text-base font-medium text-zinc-100">{recipe.name}</h3><p className="mt-1 text-xs text-zinc-500">{editable ? text.editorSubtitle : text.readonlySubtitle}</p></div>
        {!editable ? <Button size="sm" variant="primary" onClick={() => onCopied(recipe)}>{text.copy}</Button> : null}
      </header>
      {editable ? (
        <>
          <SettingsSection title={text.basicTitle} description={text.idImmutable}>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs text-zinc-400"><span>{text.name}</span><input aria-label={text.name} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200" /></label>
              <label className="text-xs text-zinc-400"><span>{text.category}</span><select aria-label={text.category} value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as SkillCategory })} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200">{CATEGORIES.map((category) => <option key={category} value={category}>{t.expert.visual.categories[category]}</option>)}</select></label>
            </div>
            <label className="block text-xs text-zinc-400"><span>{text.description}</span><textarea aria-label={text.description} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={3} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200" /></label>
          </SettingsSection>
          <SettingsSection title={text.leadTitle} description={text.leadDescription}>
            <label className="block text-xs text-zinc-400"><span>{text.leadRole}</span><select aria-label={text.leadRole} value={draft.lead?.roleId ?? ''} onChange={(event) => setDraft({ ...draft, lead: event.target.value ? { roleId: event.target.value, briefTemplate: draft.lead?.briefTemplate ?? '' } : undefined })} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200"><option value="">{text.noLead}</option>{entries.map((entry) => <option key={entry.roleId} value={entry.roleId}>{entry.displayName || entry.roleId}</option>)}</select></label>
            {lead ? <label className="mt-3 block text-xs text-zinc-400"><span>{text.briefTemplate}</span><textarea aria-label={text.briefTemplate} value={lead.briefTemplate} onChange={(event) => setDraft({ ...draft, lead: { ...lead, briefTemplate: event.target.value } })} rows={4} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200" /></label> : null}
          </SettingsSection>
          <SettingsSection title={text.membersTitle.replace('{count}', String(draft.members.length))} description={text.membersDescription} actions={<Button size="sm" variant="secondary" onClick={addMember} disabled={draft.members.length >= 5} leftIcon={<Plus className="h-3.5 w-3.5" />}>{text.addMember}</Button>}>
            <p className="text-xs text-zinc-500">{text.topicHint}</p>
            <div className="space-y-3">{draft.members.map((member, index) => <div key={`${member.roleId}-${index}`} className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3"><div className="flex gap-2"><label className="min-w-0 flex-1 text-xs text-zinc-400"><span>{text.memberRole}</span><select aria-label={`${text.memberRole} ${index + 1}`} value={member.roleId} onChange={(event) => updateMember(index, { roleId: event.target.value })} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200">{entries.map((entry) => <option key={entry.roleId} value={entry.roleId}>{entry.displayName || entry.roleId}</option>)}</select></label><button /* ds-allow:button: 成员删除为紧凑的图标操作，primitive 会额外包裹文字按钮样式 */ type="button" aria-label={`${text.removeMember} ${index + 1}`} onClick={() => setDraft((current) => ({ ...current, members: current.members.filter((_, memberIndex) => memberIndex !== index) }))} className="mt-5 rounded p-1.5 text-zinc-400 hover:bg-red-900/40 hover:text-red-300"><Trash2 className="h-4 w-4" /></button></div><label className="mt-2 block text-xs text-zinc-400"><span>{text.memberId}</span><input aria-label={`${text.memberId} ${index + 1}`} value={member.id ?? ''} onChange={(event) => updateMember(index, { id: event.target.value || undefined })} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200" /></label><label className="mt-2 block text-xs text-zinc-400"><span>{text.taskTemplate}</span><textarea aria-label={`${text.taskTemplate} ${index + 1}`} value={member.taskTemplate} onChange={(event) => updateMember(index, { taskTemplate: event.target.value })} rows={3} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200" /></label></div>)}</div>
          </SettingsSection>
          {error ? <div role="alert" className="rounded border border-red-800/70 bg-red-950/30 px-3 py-2 text-xs text-red-300">{text.saveFailed}: {error}</div> : null}
          <Button variant="primary" onClick={() => void save()} disabled={saving} data-testid="team-recipe-save">{saving ? text.saving : text.save}</Button>
        </>
      ) : (
        <>
          <SettingsSection title={text.modeTitle} description={recipe.lead ? text.expertTeamMode.replace('{lead}', roleName(recipe.lead.roleId)) : text.expertGroupMode.replace('{count}', String(recipe.members.length))}>
            <p className="text-xs text-zinc-400">{text.concurrent.replace('{count}', String(recipe.members.length))}</p>
            {recipe.lead ? <p className="text-xs text-zinc-400">{text.briefTemplate}: {recipe.lead.briefTemplate}</p> : null}
          </SettingsSection>
          <SettingsSection title={text.membersTitle.replace('{count}', String(recipe.members.length))} description={text.readonlyMembers}><ul className="space-y-2">{recipe.members.map((member, index) => <li key={`${member.roleId}-${index}`} className="rounded border border-zinc-700/60 bg-zinc-900/40 p-3 text-xs"><div className="text-zinc-200">{roleName(member.roleId)}</div><div className="mt-1 text-zinc-400">{member.taskTemplate}</div></li>)}</ul></SettingsSection>
        </>
      )}
    </div>
  );
};
