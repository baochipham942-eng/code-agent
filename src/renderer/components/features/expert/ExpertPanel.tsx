// ============================================================================
// ExpertPanel - 专家全屏页（Batch 3 E2）
// ============================================================================
//
// Tab「我的」：全部持久化角色（含用户自建），带记忆条数/最近履历 +「请 TA 来」。
// Tab「发现」：内置专家包卡片（花名/职业/tags/quickPrompts），点 quickPrompt
// 直接以该句开场请 TA 来。角色配置（主动性/删除）仍在设置页 RolesTab。

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Settings2, UserRound, UsersRound } from 'lucide-react';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import type { TeamRecipe } from '@shared/contract/teamRecipe';
import { TEAM_RECIPES } from '@shared/constants/teamRecipeCatalog';
import {
  installRolePack,
  listRolePacks,
  listRoles,
  retryRolePackMissingSkills,
  uninstallRolePack,
  type RolePackListItem,
} from '../../../services/rolesClient';
import { createTeamRecipe, deleteTeamRecipe, listTeamRecipes } from '../../../services/teamRecipeClient';
import { inviteExpert } from '../../../utils/inviteExpert';
import { launchTeamRecipe } from '../../../utils/launchTeamRecipe';
import { startCreateTeamChat } from '../../../utils/startCreateTeamChat';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { Button } from '../../primitives/Button';
import { IconButton } from '../../primitives/IconButton';
import { Input } from '../../primitives/Input';
import { Modal } from '../../primitives/Modal';
import { RoleIcon } from '../shared/RoleIcon';
import { RolePackHealthNotice, RolePackShelf } from './RolePackShelf';
import { RoleDetailPage } from './RoleDetailPage';
import { TeamRecipeDetailPage } from './TeamRecipeDetailPage';

type ExpertTab = 'mine' | 'discover';

/** 卡片头：图标瓦片 + 花名 + 职业 */
const ExpertCardHead: React.FC<{ entry: RolePanelEntry; professionFallback: string }> = ({
  entry,
  professionFallback,
}) => (
  <div className="flex items-center gap-2.5">
    <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
      <RoleIcon name={entry.icon} className="h-5 w-5" />
    </span>
    <span className="min-w-0">
      <span className="block truncate text-sm font-medium text-zinc-100">
        {entry.displayName || entry.roleId}
      </span>
      <span className="block truncate text-xs text-zinc-500">
        {entry.profession || professionFallback}
      </span>
    </span>
  </div>
);

export const ExpertPanel: React.FC = () => {
  const { t } = useI18n();
  const text = t.expert;
  const setShowExpertPanel = useAppStore((s) => s.setShowExpertPanel);
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);

  const [tab, setTab] = useState<ExpertTab>('mine');
  const [entries, setEntries] = useState<RolePanelEntry[]>([]);
  const [rolePacks, setRolePacks] = useState<RolePackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [rolePacksLoading, setRolePacksLoading] = useState(true);
  const [rolePacksError, setRolePacksError] = useState(false);
  const [busyRolePackId, setBusyRolePackId] = useState<string | null>(null);
  const [userRecipes, setUserRecipes] = useState<TeamRecipe[]>([]);
  const [activeRecipe, setActiveRecipe] = useState<TeamRecipe | null>(null);
  const [selectedRecipe, setSelectedRecipe] = useState<{ recipe: TeamRecipe; editable: boolean } | null>(null);
  const [confirmingRecipeDelete, setConfirmingRecipeDelete] = useState<string | null>(null);
  const [recipeTopic, setRecipeTopic] = useState('');
  const [selectedRole, setSelectedRole] = useState<RolePanelEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setRolePacksLoading(true);
    setRolePacksError(false);
    try {
      setEntries(await listRoles());
    } catch (error) {
      toast.error(text.loadFailed + (error instanceof Error ? `: ${error.message}` : ''));
    } finally {
      setLoading(false);
    }
    try {
      setUserRecipes(await listTeamRecipes());
    } catch (error) {
      toast.error(t.team.loadFailed + (error instanceof Error ? `: ${error.message}` : ''));
    }
    try {
      setRolePacks(await listRolePacks());
    } catch {
      // Control-plane diagnostics stay in host logs; the shelf only offers a safe retry.
      setRolePacksError(true);
    } finally {
      setRolePacksLoading(false);
    }
  }, [text]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = (entry: RolePanelEntry, seed?: string) => {
    void inviteExpert(entry.roleId, { seed, title: entry.displayName || entry.roleId });
  };

  const loadRolePacks = async () => {
    setRolePacksLoading(true);
    setRolePacksError(false);
    try {
      setRolePacks(await listRolePacks());
    } catch {
      setRolePacksError(true);
    } finally {
      setRolePacksLoading(false);
    }
  };

  const runRolePackAction = async (
    roleId: string,
    action: (id: string) => Promise<{ success: boolean }>,
  ) => {
    setBusyRolePackId(roleId);
    try {
      const result = await action(roleId);
      if (!result.success) toast.error(t.rolePack.actionFailed);
      await loadRolePacks();
      setEntries(await listRoles());
    } catch {
      toast.error(t.rolePack.actionFailed);
    } finally {
      setBusyRolePackId(null);
    }
  };

  const discoverEntries = entries.filter((e) => e.source === 'builtin');
  const shown = tab === 'mine' ? entries : discoverEntries;
  const rolePacksByRoleId = new Map(rolePacks.map((item) => [item.entry.roleId, item]));

  const openRecipe = (recipe: TeamRecipe) => {
    setActiveRecipe(recipe);
    setRecipeTopic('');
  };

  const closeRecipe = () => {
    setActiveRecipe(null);
    setRecipeTopic('');
  };

  const launchActiveRecipe = async () => {
    if (!activeRecipe || !recipeTopic.trim()) return;
    const result = await launchTeamRecipe(activeRecipe.id, activeRecipe.name, recipeTopic.trim());
    if (!result.ok) {
      toast.error(t.team.launchFailed + (result.error ? `: ${result.error}` : ''));
    }
  };

  const copyRecipe = async (recipe: TeamRecipe) => {
    try {
      const copied = await createTeamRecipe({
        name: recipe.name,
        description: recipe.description,
        category: recipe.category,
        members: recipe.members.map((member) => ({ ...member })),
        lead: recipe.lead ? { ...recipe.lead } : undefined,
        tags: recipe.tags,
      });
      setUserRecipes((current) => [...current, copied]);
      setSelectedRecipe({ recipe: copied, editable: true });
    } catch (error) {
      toast.error(t.team.copyFailed + (error instanceof Error ? `: ${error.message}` : ''));
    }
  };

  const removeRecipe = async (recipeId: string) => {
    try {
      await deleteTeamRecipe(recipeId);
      setUserRecipes((current) => current.filter((recipe) => recipe.id !== recipeId));
      setConfirmingRecipeDelete(null);
    } catch (error) {
      toast.error(t.team.deleteFailed + (error instanceof Error ? `: ${error.message}` : ''));
    }
  };

  const recipeMode = (recipe: TeamRecipe) => recipe.lead
    ? t.team.expertTeam.replace('{lead}', entries.find((entry) => entry.roleId === recipe.lead?.roleId)?.displayName || recipe.lead.roleId)
    : t.team.expertGroup.replace('{count}', String(recipe.members.length));

  return (
    <FullScreenPage testId="expert-panel">
      <FullScreenPageHeader
        icon={<UsersRound className="h-4 w-4 text-violet-300" />}
        title={text.panelTitle}
        description={text.panelDescription}
        onClose={() => setShowExpertPanel(false)}
        closeLabel={t.common.close}
        actions={selectedRole || selectedRecipe ? undefined : (
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-zinc-700 p-0.5" role="tablist">
              {(['mine', 'discover'] as const).map((key) => (
                <button /* ds-allow:button: tab 切换胶囊（role=tab 分段控件），Button primitive 无 tab 语义变体 */
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  data-testid={`expert-tab-${key}`}
                  onClick={() => setTab(key)}
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    tab === key ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {key === 'mine' ? text.tabMine : text.tabDiscover}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
              leftIcon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />}
            >
              {text.refresh}
            </Button>
          </div>
        )}
      />

      <div className="flex-1 overflow-y-auto p-4">
        {selectedRole ? (
          <RoleDetailPage
            roleId={selectedRole.roleId}
            icon={selectedRole.icon}
            backLabel={text.back}
            onVisualUpdated={() => { void load(); }}
            onBack={() => setSelectedRole(null)}
          />
        ) : selectedRecipe ? (
          <TeamRecipeDetailPage
            recipe={selectedRecipe.recipe}
            entries={entries}
            editable={selectedRecipe.editable}
            onBack={() => setSelectedRecipe(null)}
            onCopied={(recipe) => { void copyRecipe(recipe); }}
            onSaved={(recipe) => {
              setUserRecipes((current) => current.map((item) => item.id === recipe.id ? recipe : item));
              setSelectedRecipe({ recipe, editable: true });
            }}
          />
        ) : (
          <>
        {!loading && tab === 'mine' && shown.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-700/70 p-8 text-center text-sm text-zinc-500">
            {text.empty}
          </div>
        ) : (
          <div className="space-y-6">
            {tab === 'discover' ? (
              <section aria-labelledby="team-recipes-title">
                <h2 id="team-recipes-title" className="mb-3 text-sm font-medium text-zinc-200">
                  <span>{t.team.sectionTitle}</span>
                  <Button className="ml-2" variant="ghost" size="sm" onClick={() => void startCreateTeamChat()}>{t.team.createByChat}</Button>
                </h2>
                <h3 className="mb-2 text-xs font-medium text-zinc-400">{t.team.builtinRecipes}</h3>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {TEAM_RECIPES.map((recipe) => (
                    <div
                      key={recipe.id}
                      data-testid={`team-recipe-${recipe.id}`}
                      className="flex flex-col gap-2.5 rounded-xl border border-violet-900/60 bg-violet-950/20 p-3.5"
                    >
                      <div>
                        <button /* ds-allow:button: 出厂配方名是进入只读详情的文字链接，卡片底部动作仍仅保留使用与复制 */ type="button" aria-label={`${t.team.details} ${recipe.name}`} onClick={() => setSelectedRecipe({ recipe, editable: false })} className="text-left text-sm font-medium text-zinc-100 hover:text-violet-200">{recipe.name}</button>
                        <p className="mt-1 text-xs text-violet-200/70">
                          {recipeMode(recipe)}
                        </p>
                      </div>
                      <p className="text-xs leading-relaxed text-zinc-400">{recipe.description}</p>
                      <div className="mt-auto flex gap-2 pt-1">
                        <Button variant="secondary" size="sm" onClick={() => openRecipe(recipe)}>
                          {t.team.useRecipe}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => { void copyRecipe(recipe); }}>{t.team.copy}</Button>
                      </div>
                    </div>
                  ))}
                </div>
                <h3 className="mb-2 mt-5 text-xs font-medium text-zinc-400">{t.team.myRecipes}</h3>
                {userRecipes.length === 0 ? <p className="text-xs text-zinc-500">{t.team.myRecipes}</p> : null}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {userRecipes.map((recipe) => (
                    <div key={recipe.id} data-testid={`team-recipe-${recipe.id}`} className="flex flex-col gap-2.5 rounded-xl border border-zinc-700/70 bg-zinc-900/60 p-3.5">
                      <div><h3 className="text-sm font-medium text-zinc-100">{recipe.name}</h3><p className="mt-1 text-xs text-violet-200/70">{recipeMode(recipe)}</p></div>
                      <p className="text-xs leading-relaxed text-zinc-400">{recipe.description}</p>
                      {confirmingRecipeDelete === recipe.id ? <div className="flex items-center gap-2 text-xs text-red-300"><span>{t.team.confirmDelete}</span><button /* ds-allow:button: 配方删除确认使用紧凑文字动作，现有 Button 的尺寸会挤压卡片 */ type="button" onClick={() => { void removeRecipe(recipe.id); }} className="rounded bg-red-900/50 px-2 py-1 hover:bg-red-900/80">{t.team.delete}</button><button /* ds-allow:button: 配方删除取消是紧凑文本按钮，保持卡片内联布局 */ type="button" onClick={() => setConfirmingRecipeDelete(null)} className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-700">{t.team.cancel}</button></div> : <div className="mt-auto flex flex-wrap gap-2 pt-1"><Button variant="secondary" size="sm" onClick={() => openRecipe(recipe)}>{t.team.useRecipe}</Button><Button variant="ghost" size="sm" onClick={() => setSelectedRecipe({ recipe, editable: true })}>{t.team.details}</Button><Button variant="ghost" size="sm" onClick={() => setConfirmingRecipeDelete(recipe.id)}>{t.team.delete}</Button></div>}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {tab === 'discover' ? (
              <RolePackShelf
                items={rolePacks}
                loading={rolePacksLoading}
                error={rolePacksError}
                busyRoleId={busyRolePackId}
                onRetryLoad={() => { void loadRolePacks(); }}
                onInstall={(roleId) => { void runRolePackAction(roleId, installRolePack); }}
                onUninstall={(roleId) => { void runRolePackAction(roleId, uninstallRolePack); }}
                onRetryMissingSkills={(roleId) => { void runRolePackAction(roleId, retryRolePackMissingSkills); }}
              />
            ) : null}

            {tab === 'discover' && !loading && shown.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-700/70 p-8 text-center text-sm text-zinc-500">
                {text.empty}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((entry) => (
              <div
                key={entry.roleId}
                data-testid={`expert-card-${entry.roleId}`}
                className="flex flex-col gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <ExpertCardHead entry={entry} professionFallback={text.professionFallback} />
                  <IconButton
                    icon={<Settings2 className="h-3.5 w-3.5" />}
                    aria-label={text.configure}
                    title={text.configure}
                    size="sm"
                    variant="ghost"
                    onClick={() => openSettingsTab('roles')}
                  />
                </div>

                {entry.description ? (
                  <p className="line-clamp-2 text-xs leading-relaxed text-zinc-400">{entry.description}</p>
                ) : null}

                {entry.tags && entry.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {entry.tags.map((tag) => (
                      <span key={tag} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}

                {tab === 'mine' ? (
                  <div className="text-[11px] text-zinc-500">
                    {entry.memoryCount > 0 || entry.lastWork
                      ? (
                        <>
                          <span>{text.memoryCount.replace('{count}', String(entry.memoryCount))}</span>
                          {entry.lastWork ? (
                            <span className="ml-2 truncate">{text.lastWorkPrefix}{entry.lastWork}</span>
                          ) : null}
                        </>
                      )
                      : text.noRecordYet}
                  </div>
                ) : null}

                {tab === 'mine' ? (
                  <RolePackHealthNotice
                    item={rolePacksByRoleId.get(entry.roleId)}
                    busy={busyRolePackId === entry.roleId}
                    onRetryMissingSkills={(roleId) => { void runRolePackAction(roleId, retryRolePackMissingSkills); }}
                  />
                ) : null}

                {entry.quickPrompts && entry.quickPrompts.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-wide text-zinc-600">{text.quickPromptsTitle}</span>
                    {entry.quickPrompts.map((prompt) => (
                      <button /* ds-allow:button: quickPrompt 引导句列表行（左对齐引号文案），Button primitive 是居中动作按钮形状 */
                        key={prompt}
                        type="button"
                        data-testid="expert-quick-prompt"
                        onClick={() => invite(entry, prompt)}
                        className="rounded-md bg-zinc-800/60 px-2 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-700/70 hover:text-zinc-100"
                      >
                        “{prompt}”
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="mt-auto flex gap-2 pt-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid={`expert-detail-${entry.roleId}`}
                    onClick={() => setSelectedRole(entry)}
                  >
                    {text.details}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    data-testid={`expert-invite-${entry.roleId}`}
                    onClick={() => invite(entry)}
                    leftIcon={<UserRound className="h-3.5 w-3.5" />}
                  >
                    {text.invite}
                  </Button>
                </div>
              </div>
            ))}
            </div>
          </div>
        )}
          </>
        )}
      </div>

      <Modal
        isOpen={activeRecipe !== null}
        onClose={closeRecipe}
        title={activeRecipe?.name}
        size="sm"
        footer={(
          <Button
            variant="primary"
            onClick={() => { void launchActiveRecipe(); }}
            disabled={!recipeTopic.trim()}
          >
            {t.team.launch}
          </Button>
        )}
      >
        <div className="space-y-2">
          <Input
            autoFocus
            value={recipeTopic}
            placeholder={t.team.topicPlaceholder}
            onChange={(event) => setRecipeTopic(event.target.value)}
          />
          {!recipeTopic.trim() ? (
            <p className="text-xs text-zinc-500">{t.team.topicRequired}</p>
          ) : null}
        </div>
      </Modal>
    </FullScreenPage>
  );
};
