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
import { TEAM_RECIPES } from '@shared/constants/teamRecipeCatalog';
import { listRoles } from '../../../services/rolesClient';
import { inviteExpert } from '../../../utils/inviteExpert';
import { launchTeamRecipe } from '../../../utils/launchTeamRecipe';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { Button } from '../../primitives/Button';
import { IconButton } from '../../primitives/IconButton';
import { Input } from '../../primitives/Input';
import { Modal } from '../../primitives/Modal';
import { RoleIcon } from '../shared/RoleIcon';

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
  const [loading, setLoading] = useState(true);
  const [activeRecipeId, setActiveRecipeId] = useState<string | null>(null);
  const [recipeTopic, setRecipeTopic] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await listRoles());
    } catch (error) {
      toast.error(text.loadFailed + (error instanceof Error ? `: ${error.message}` : ''));
    } finally {
      setLoading(false);
    }
  }, [text]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = (entry: RolePanelEntry, seed?: string) => {
    void inviteExpert(entry.roleId, { seed, title: entry.displayName || entry.roleId });
  };

  const discoverEntries = entries.filter((e) => e.source === 'builtin');
  const shown = tab === 'mine' ? entries : discoverEntries;
  const activeRecipe = TEAM_RECIPES.find((recipe) => recipe.id === activeRecipeId);

  const openRecipe = (recipeId: string) => {
    setActiveRecipeId(recipeId);
    setRecipeTopic('');
  };

  const closeRecipe = () => {
    setActiveRecipeId(null);
    setRecipeTopic('');
  };

  const launchActiveRecipe = async () => {
    if (!activeRecipe || !recipeTopic.trim()) return;
    const result = await launchTeamRecipe(activeRecipe.id, activeRecipe.name, recipeTopic.trim());
    if (!result.ok) {
      toast.error(t.team.launchFailed + (result.error ? `: ${result.error}` : ''));
    }
  };

  return (
    <FullScreenPage testId="expert-panel">
      <FullScreenPageHeader
        icon={<UsersRound className="h-4 w-4 text-violet-300" />}
        title={text.panelTitle}
        description={text.panelDescription}
        onClose={() => setShowExpertPanel(false)}
        closeLabel={t.common.close}
        actions={(
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
        {!loading && tab === 'mine' && shown.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-700/70 p-8 text-center text-sm text-zinc-500">
            {text.empty}
          </div>
        ) : (
          <div className="space-y-6">
            {tab === 'discover' ? (
              <section aria-labelledby="team-recipes-title">
                <h2 id="team-recipes-title" className="mb-3 text-sm font-medium text-zinc-200">
                  {t.team.sectionTitle}
                </h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {TEAM_RECIPES.map((recipe) => (
                    <div
                      key={recipe.id}
                      data-testid={`team-recipe-${recipe.id}`}
                      className="flex flex-col gap-2.5 rounded-xl border border-violet-900/60 bg-violet-950/20 p-3.5"
                    >
                      <div>
                        <h3 className="text-sm font-medium text-zinc-100">{recipe.name}</h3>
                        <p className="mt-1 text-xs text-violet-200/70">
                          {recipe.lead ? `${t.team.lead} · ${recipe.lead.roleId}` : [...new Set(recipe.members.map((member) => member.roleId))].join(' + ')}
                        </p>
                      </div>
                      <p className="text-xs leading-relaxed text-zinc-400">{recipe.description}</p>
                      <div className="mt-auto pt-1">
                        <Button variant="secondary" size="sm" onClick={() => openRecipe(recipe.id)}>
                          {t.team.useRecipe}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
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

                {tab === 'discover' && entry.tags && entry.tags.length > 0 ? (
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

                {tab === 'discover' && entry.quickPrompts && entry.quickPrompts.length > 0 ? (
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

                <div className="mt-auto pt-1">
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
      </div>

      <Modal
        isOpen={activeRecipe !== undefined}
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
