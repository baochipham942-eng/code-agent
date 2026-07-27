// ============================================================================
// ExpertPanel - 能力中心的专家 tab
// ============================================================================
//
// Tab「我的」（默认）：全部持久化角色（含用户自建），带记忆条数/最近履历 +「请 TA 来」；
// 为空时给指向「发现」的引导。
// Tab「发现」：内置专家包卡片（花名/职业/tags/quickPrompts），点 quickPrompt
// 直接以该句开场请 TA 来（inviteExpert 的 pendingRoleChatSeed 通道）。
//
// 货架卡片统一契约（专家团 / 专家 / 云货架共用一套语言，紫底渐变已退役）：
// 容器 SHELF_CARD_CLASS（zinc 底）+ 卡片头（图标瓦片 + 名称 + 角色/来源徽标）
// + 一句话价值 + 场景标签 + 底部主 CTA（品牌色 primary 只留给主动作）。
// 分类 chips 口径：RolePanelEntry.category 是现成分类字段（SkillCategory 子集，
// 与技能包同套体系），直接按 SKILL_CATEGORIES 顺序推导；无 category 的自建角色归「其他」。

import React, { useCallback, useEffect, useState } from 'react';
import { Quote, RefreshCw, UserRound, Users } from 'lucide-react';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import type { TeamRecipe } from '@shared/contract/teamRecipe';
import { TEAM_RECIPES } from '@shared/constants/teamRecipeCatalog';
import { RECOMMENDED_MCP_SERVERS } from '@shared/constants/mcpCatalog';
import { groupToolsForConsent } from '@shared/constants/toolConsentGroups';
import type { RolePackActionResult } from '../../../services/rolesClient';
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
import { startCreateRoleChat } from '../../../utils/startCreateRoleChat';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { Button } from '../../primitives/Button';
import { Badge } from '../../primitives/Badge';
import { Input } from '../../primitives/Input';
import { Modal } from '../../primitives/Modal';
import { RoleIcon } from '../shared/RoleIcon';
import { RolePackHealthNotice, RolePackShelf } from './RolePackShelf';
import { TeamRecipeDetailPage } from './TeamRecipeDetailPage';
import { groupRolesByCategory } from './roleCategoryGroups';

type ExpertTab = 'mine' | 'discover';

/** 货架卡统一容器：专家卡 / 专家团卡 / 云货架卡同底同距，紫底渐变已退役 */
const SHELF_CARD_CLASS = 'flex flex-col gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5';
/** 场景标签统一样式（专家卡 tags / 专家团 tags 共用） */
const SHELF_TAG_CLASS = 'rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400';
/** 云货架拉取超过这个时长就当作超时，给可退出的空态 + 重试，不再让「正在加载…」常驻 */
const ROLE_PACKS_LOAD_TIMEOUT_MS = 8000;

/** 来源徽标文案：复用设置页角色卡的同一套口径（预设/自建/项目/缺定义），不再另造一套词 */
function expertSourceLabel(entry: RolePanelEntry, sourceText: Record<string, string>): string {
  return sourceText[entry.source === 'orphan' ? 'missing' : entry.source] ?? entry.source;
}

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

const ExpertCard: React.FC<{
  entry: RolePanelEntry;
  tab: ExpertTab;
  text: ReturnType<typeof useI18n>['t']['expert'];
  sourceText: Record<string, string>;
  rolePacksByRoleId: Map<string, RolePackListItem>;
  busyRolePackId: string | null;
  onRetryMissingSkills: (roleId: string) => void;
  onDetail: () => void;
  onInvite: (seed?: string) => void;
}> = ({ entry, tab, text, sourceText, rolePacksByRoleId, busyRolePackId, onRetryMissingSkills, onDetail, onInvite }) => (
  <div data-testid={`expert-card-${entry.roleId}`} className={SHELF_CARD_CLASS}>
    <div className="flex items-start justify-between gap-2">
      <ExpertCardHead entry={entry} professionFallback={text.professionFallback} />
      <Badge data-testid={`expert-source-${entry.roleId}`} className="flex-shrink-0 border-zinc-700 bg-zinc-800 text-[10px] text-zinc-400">{expertSourceLabel(entry, sourceText)}</Badge>
    </div>
    {entry.description ? <p className="line-clamp-2 text-xs leading-relaxed text-zinc-400">{entry.description}</p> : null}
    {entry.tags && entry.tags.length > 0 ? (
      <div className="flex flex-wrap gap-1">
        {entry.tags.map((tag) => <span key={tag} className={SHELF_TAG_CLASS}>{tag}</span>)}
      </div>
    ) : null}
    {/* truncate 只对块级生效：外层必须 flex + min-w-0，否则长履历会撑破卡片 */}
    {tab === 'mine' ? (
      <div className="flex min-w-0 items-baseline text-[11px] text-zinc-500">
        {entry.memoryCount > 0 || entry.lastWork ? <><span className="flex-shrink-0">{text.memoryCount.replace('{count}', String(entry.memoryCount))}</span>{entry.lastWork ? <span className="ml-2 min-w-0 truncate" title={entry.lastWork}>{text.lastWorkPrefix}{entry.lastWork}</span> : null}</> : text.noRecordYet}
      </div>
    ) : null}
    {tab === 'mine' ? <RolePackHealthNotice item={rolePacksByRoleId.get(entry.roleId)} busy={busyRolePackId === entry.roleId} onRetryMissingSkills={onRetryMissingSkills} /> : null}
    {entry.quickPrompts?.[0] ? (
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-zinc-600">{text.quickPromptsTitle}</span>
        {/* 引用条是这张卡最好的用法教学：点击 = 以该句发起新会话（inviteExpert seed 通道）。
            用边框 + 引号图标 + hover 提亮把「可点」做出来，不再伪装成灰底装饰。 */}
        <button /* ds-allow:button: quickPrompt 引导句列表行（左对齐引号文案），Button primitive 是居中动作按钮形状 */ type="button" data-testid="expert-quick-prompt" onClick={() => onInvite(entry.quickPrompts?.[0])} className="flex items-start gap-1.5 rounded-md border border-zinc-700/60 bg-zinc-800/40 px-2 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-100">
          <Quote className="mt-0.5 h-3 w-3 flex-shrink-0 text-zinc-500" />
          <span>{entry.quickPrompts[0]}</span>
        </button>
      </div>
    ) : null}
    <div className="mt-auto flex gap-2 pt-1">
      <Button variant="secondary" size="sm" data-testid={`expert-detail-${entry.roleId}`} onClick={onDetail}>{text.details}</Button>
      <Button variant="primary" size="sm" data-testid={`expert-invite-${entry.roleId}`} onClick={() => onInvite()} leftIcon={<UserRound className="h-3.5 w-3.5" />}>{text.invite}</Button>
    </div>
  </div>
);

export const ExpertPanel: React.FC = () => {
  const { t } = useI18n();
  const text = t.expert;
  const openExpertRoleDetail = useAppStore((s) => s.openExpertRoleDetail);

  const [tab, setTab] = useState<ExpertTab>('mine');
  const [entries, setEntries] = useState<RolePanelEntry[]>([]);
  const [rolePacks, setRolePacks] = useState<RolePackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [rolePacksLoading, setRolePacksLoading] = useState(true);
  const [rolePacksError, setRolePacksError] = useState(false);
  const [rolePacksTimedOut, setRolePacksTimedOut] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [busyRolePackId, setBusyRolePackId] = useState<string | null>(null);
  const [userRecipes, setUserRecipes] = useState<TeamRecipe[]>([]);
  const [activeRecipe, setActiveRecipe] = useState<TeamRecipe | null>(null);
  const [selectedRecipe, setSelectedRecipe] = useState<{ recipe: TeamRecipe; editable: boolean } | null>(null);
  const [confirmingRecipeDelete, setConfirmingRecipeDelete] = useState<string | null>(null);
  const [recipeTopic, setRecipeTopic] = useState('');
  const [pendingConsent, setPendingConsent] = useState<({ roleId: string } & NonNullable<RolePackActionResult['consent']>) | null>(null);

  const consentToolSummary = groupToolsForConsent(pendingConsent?.tools ?? []);
  /** 连接器给用户看产品名（技术 id 只留在详情页）；目录里查不到就退回 id，别让一项依赖消失。 */
  const describeConnector = (connector: { id: string; reason?: string }): string => {
    const name = RECOMMENDED_MCP_SERVERS.find((server) => server.id === connector.id)?.name ?? connector.id;
    return connector.reason ? `${name}（${connector.reason}）` : name;
  };
  /** 权限档说结果，不吐 strict/development/ci；复用「安全」页那套已经写成人话的档位描述。 */
  const describePermissionPreset = (preset: 'strict' | 'development' | 'ci'): string => {
    const entry = t.expert.roleSecurity.presets[preset] as { label: string; hint: string } | undefined;
    return entry ? `${entry.label}——${entry.hint}` : preset;
  };

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

  // 云货架超时空态：listRolePacks 挂起（云货架拉不到）时「正在加载…」会常驻，
  // 超过 ROLE_PACKS_LOAD_TIMEOUT_MS 就换成超时空态 + 重试，给用户退出路径。
  useEffect(() => {
    if (!rolePacksLoading) {
      setRolePacksTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setRolePacksTimedOut(true), ROLE_PACKS_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [rolePacksLoading]);

  // 切 tab 时分类过滤回到「全部」，避免「我的」里选的分类把「发现」过滤空
  useEffect(() => {
    setSelectedCategory('all');
  }, [tab]);

  const invite = (entry: RolePanelEntry, seed?: string) => {
    void inviteExpert(entry.roleId, { seed, title: entry.displayName || entry.roleId });
  };

  const loadRolePacks = async () => {
    setRolePacksLoading(true);
    setRolePacksError(false);
    setRolePacksTimedOut(false);
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

  // 云包安装单独走一条：未过目时不当作失败，而是弹摘要卡让用户看清这个专家能干什么。
  // 强确认——每个包都要过这一关，不只提权包（装之前用户根本不知道它能读文件、要连哪个连接器）。
  const installWithElevation = async (roleId: string, options?: { acceptElevation?: boolean; elevationReviewed?: boolean }) => {
    setBusyRolePackId(roleId);
    try {
      const result = await installRolePack(roleId, options);
      if (result.consent) {
        setPendingConsent({ roleId, ...result.consent });
        return;
      }
      setPendingConsent(null);
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
  // 分类 chips 推导口径：category 是角色数据的现成字段（SkillCategory 子集），
  // 直接复用 groupRolesByCategory（顺序跟 SKILL_CATEGORIES，无 category 归「其他」），
  // 不另起 tag 聚类——tags 是自由文本，聚出来不可控。
  const categoryGroups = groupRolesByCategory(shown, {
    categories: t.settings.roles.categories,
    uncategorized: t.settings.roles.uncategorizedCategory,
  });
  const activeCategory = categoryGroups.some((group) => group.key === selectedCategory) ? selectedCategory : 'all';
  const filteredShown = activeCategory === 'all'
    ? shown
    : categoryGroups.find((group) => group.key === activeCategory)?.entries ?? [];
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

  // 滚动由能力中心的外层容器统一负责，这里只排内容；
  // 「我的 / 发现」操作条 sticky 住，否则列表一长就被滚出视野。
  return (
    <div data-testid="expert-panel">
      {selectedRecipe ? null : (
          <div className="sticky top-0 z-10 -mx-6 mb-3 flex items-center justify-end gap-2 border-b border-zinc-800/70 bg-zinc-900/90 px-6 py-2 backdrop-blur">
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
            <Button variant="secondary" size="sm" onClick={() => void startCreateRoleChat()} data-testid="expert-create-role">
              {text.createExpert}
            </Button>
          </div>
      )}
      {/* 场景分类 chips：按角色 category 字段推导（见上方推导口径注释），当前 tab 的条目集里出现的分类才上架 */}
      {!selectedRecipe && !loading && categoryGroups.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5" data-testid="expert-category-chips">
          {[{ key: 'all', label: text.categoryAll }, ...categoryGroups.map((group) => ({ key: group.key, label: group.label }))].map((chip) => (
            <button /* ds-allow:button: 分类过滤 chip（aria-pressed 切换胶囊），Button primitive 无 chip/筛选语义变体 */
              key={chip.key}
              type="button"
              aria-pressed={activeCategory === chip.key}
              data-testid={`expert-category-chip-${chip.key}`}
              onClick={() => setSelectedCategory(chip.key)}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                activeCategory === chip.key
                  ? 'border-zinc-500 bg-zinc-700 text-zinc-100'
                  : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}
      <div>
        {selectedRecipe ? (
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
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-zinc-700/70 p-8 text-center text-sm text-zinc-500">
            <span>{text.emptyMine}</span>
            <Button variant="secondary" size="sm" data-testid="expert-empty-goto-discover" onClick={() => setTab('discover')}>{text.emptyMineAction}</Button>
          </div>
        ) : (
          <div className="space-y-6">
            {tab === 'discover' ? (
              <section aria-labelledby="team-recipes-title">
                <h2 id="team-recipes-title" className="mb-3 text-sm font-medium text-zinc-200">
                  <span>{t.team.sectionTitle}</span>
                  <Button className="ml-2" variant="ghost" size="sm" onClick={() => void startCreateTeamChat(t.team.createChatSessionTitle)}>{t.team.createByChat}</Button>
                </h2>
                <h3 className="mb-2 text-xs font-medium text-zinc-400">{t.team.builtinRecipes}</h3>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {TEAM_RECIPES.map((recipe) => (
                    <div
                      key={recipe.id}
                      data-testid={`team-recipe-${recipe.id}`}
                      className={SHELF_CARD_CLASS}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
                            <Users className="h-5 w-5 text-violet-300" />
                          </span>
                          <span className="min-w-0">
                            <button /* ds-allow:button: 出厂专家团名是进入只读详情的文字链接，卡片底部动作仍仅保留使用与复制 */ type="button" aria-label={`${t.team.details} ${recipe.name}`} onClick={() => setSelectedRecipe({ recipe, editable: false })} className="block truncate text-left text-sm font-medium text-zinc-100 hover:text-zinc-50">{recipe.name}</button>
                            <span className="block truncate text-xs text-zinc-500">
                              {recipeMode(recipe)}
                            </span>
                          </span>
                        </div>
                        <Badge className="flex-shrink-0 border-zinc-700 bg-zinc-800 text-[10px] text-zinc-400">{t.settings.roles.card.source.builtin}</Badge>
                      </div>
                      <p className="line-clamp-2 text-xs leading-relaxed text-zinc-400">{recipe.description}</p>
                      {recipe.tags && recipe.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {recipe.tags.map((tag) => <span key={tag} className={SHELF_TAG_CLASS}>{tag}</span>)}
                        </div>
                      ) : null}
                      <div className="mt-auto flex gap-2 pt-1">
                        <Button variant="primary" size="sm" onClick={() => openRecipe(recipe)}>
                          {t.team.useRecipe}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => { void copyRecipe(recipe); }}>{t.team.copy}</Button>
                      </div>
                    </div>
                  ))}
                </div>
                <h3 className="mb-2 mt-5 text-xs font-medium text-zinc-400">{t.team.myRecipes}</h3>
                {userRecipes.length === 0 ? <p data-testid="team-my-recipes-empty" className="text-xs text-zinc-500">{t.team.myRecipesEmpty}</p> : null}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {userRecipes.map((recipe) => (
                    <div key={recipe.id} data-testid={`team-recipe-${recipe.id}`} className={SHELF_CARD_CLASS}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
                            <Users className="h-5 w-5 text-violet-300" />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-zinc-100">{recipe.name}</span>
                            <span className="block truncate text-xs text-zinc-500">{recipeMode(recipe)}</span>
                          </span>
                        </div>
                        <Badge className="flex-shrink-0 border-zinc-700 bg-zinc-800 text-[10px] text-zinc-400">{t.settings.roles.card.source.user}</Badge>
                      </div>
                      <p className="line-clamp-2 text-xs leading-relaxed text-zinc-400">{recipe.description}</p>
                      {recipe.tags && recipe.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {recipe.tags.map((tag) => <span key={tag} className={SHELF_TAG_CLASS}>{tag}</span>)}
                        </div>
                      ) : null}
                      {confirmingRecipeDelete === recipe.id ? <div className="flex items-center gap-2 text-xs text-red-300"><span>{t.team.confirmDelete}</span><button /* ds-allow:button: 专家团删除确认使用紧凑文字动作，现有 Button 的尺寸会挤压卡片 */ type="button" onClick={() => { void removeRecipe(recipe.id); }} className="rounded bg-red-900/50 px-2 py-1 hover:bg-red-900/80">{t.team.delete}</button><button /* ds-allow:button: 专家团删除取消是紧凑文本按钮，保持卡片内联布局 */ type="button" onClick={() => setConfirmingRecipeDelete(null)} className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-700">{t.team.cancel}</button></div> : <div className="mt-auto flex flex-wrap gap-2 pt-1"><Button variant="primary" size="sm" onClick={() => openRecipe(recipe)}>{t.team.useRecipe}</Button><Button variant="secondary" size="sm" onClick={() => setSelectedRecipe({ recipe, editable: true })}>{t.team.details}</Button><Button variant="ghost" size="sm" onClick={() => setConfirmingRecipeDelete(recipe.id)}>{t.team.delete}</Button></div>}
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
                timedOut={rolePacksTimedOut}
                busyRoleId={busyRolePackId}
                onRetryLoad={() => { void loadRolePacks(); }}
                onInstall={(roleId) => { void installWithElevation(roleId); }}
                onUninstall={(roleId) => { void runRolePackAction(roleId, uninstallRolePack); }}
                onRetryMissingSkills={(roleId) => { void runRolePackAction(roleId, retryRolePackMissingSkills); }}
              />
            ) : null}

            {pendingConsent ? (
              <div
                data-testid="role-pack-consent-confirm"
                className={`mt-3 rounded-lg border p-4 ${pendingConsent.elevation ? 'border-amber-700/60 bg-amber-500/5' : 'border-zinc-700 bg-white/[0.02]'}`}
              >
                <div className={`text-sm ${pendingConsent.elevation ? 'text-amber-100' : 'text-zinc-100'}`}>
                  {pendingConsent.elevation ? t.expert.rolePackElevation.title : t.expert.rolePackConsent.title}
                </div>
                <p className="mt-1 text-xs text-zinc-400">{t.expert.rolePackConsent.description}</p>
                <ul className="mt-2 space-y-1 text-xs text-zinc-300" data-testid="role-pack-consent-summary">
                  {/* 提权项加重在最前：它们是「比基线更放手」的部分 */}
                  {pendingConsent.elevation?.looseMode ? <li className="text-amber-200">· {t.expert.rolePackElevation.looseMode}</li> : null}
                  {pendingConsent.elevation?.bashTool ? <li className="text-amber-200">· {t.expert.rolePackElevation.bashTool}</li> : null}
                  <li>· {pendingConsent.tools.length === 0
                    ? t.expert.rolePackConsent.toolsNone
                    : (pendingConsent.toolsDeclared ? t.expert.rolePackConsent.toolsDeclared : t.expert.rolePackConsent.toolsBaseline)}</li>
                  {consentToolSummary.groups.map(({ group, effects }) => (
                    <li key={group} className="ml-3 text-zinc-400">
                      {t.expert.rolePackConsent.toolGroups[group]}：
                      {effects.map((effect) => t.expert.rolePackConsent.toolEffects[effect]).join('、')}
                    </li>
                  ))}
                  {/* 映射表没收录的工具原样露出：漏显示一项能力等于骗用户，看不懂也好过看不见 */}
                  {consentToolSummary.unmapped.length > 0 ? (
                    <li className="ml-3 text-zinc-400">
                      {t.expert.rolePackConsent.toolsOther}：{consentToolSummary.unmapped.join('、')}
                    </li>
                  ) : null}
                  {pendingConsent.connectors.length > 0 ? (
                    <li>· {t.expert.rolePackConsent.connectors.replace(
                      '{connectors}',
                      pendingConsent.connectors.map(describeConnector).join('、'),
                    )}</li>
                  ) : null}
                  {pendingConsent.permissionPreset ? (
                    <li>· {t.expert.rolePackConsent.permissionPreset.replace(
                      '{preset}',
                      describePermissionPreset(pendingConsent.permissionPreset),
                    )}</li>
                  ) : null}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="primary" size="sm" data-testid="role-pack-elevation-safe" onClick={() => { void installWithElevation(pendingConsent.roleId, { elevationReviewed: true }); }}>
                    {pendingConsent.elevation ? t.expert.rolePackElevation.installSafe : t.expert.rolePackConsent.install}
                  </Button>
                  {pendingConsent.elevation ? (
                    <Button variant="secondary" size="sm" data-testid="role-pack-elevation-accept" onClick={() => { void installWithElevation(pendingConsent.roleId, { acceptElevation: true }); }}>
                      {t.expert.rolePackElevation.installAsDeclared}
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => setPendingConsent(null)}>
                    {t.expert.rolePackElevation.cancel}
                  </Button>
                </div>
              </div>
            ) : null}

            {tab === 'discover' && !loading && shown.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-700/70 p-8 text-center text-sm text-zinc-500">
                {text.empty}
              </div>
            ) : null}

            {/* 分类标题用 col-span-full 横跨整行，卡片留在同一个 grid 里连续排布：
                每组各起一个 grid 会让只有 1–2 位专家的分类把整行拉空。
                选中某个分类 chip 后收敛为扁平过滤网格，不再重复分组标题。 */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {tab === 'mine' && activeCategory === 'all'
                ? categoryGroups.flatMap((group) => [
                  <div
                    key={`category-${group.key}`}
                    data-role-category={group.key}
                    className="col-span-full pt-2 text-xs font-medium uppercase tracking-wide text-zinc-500 first:pt-0"
                  >
                    {group.label}{t.settings.roles.categoryCountPrefix}{group.entries.length}{t.settings.roles.categoryCountSuffix}
                  </div>,
                  ...group.entries.map((entry) => (
                    <ExpertCard
                      key={entry.roleId}
                      entry={entry}
                      tab={tab}
                      text={text}
                      sourceText={t.settings.roles.card.source}
                      rolePacksByRoleId={rolePacksByRoleId}
                      busyRolePackId={busyRolePackId}
                      onRetryMissingSkills={(roleId) => { void runRolePackAction(roleId, retryRolePackMissingSkills); }}
                      onDetail={() => openExpertRoleDetail(entry.roleId)}
                      onInvite={(seed) => invite(entry, seed)}
                    />
                  )),
                ])
                : filteredShown.map((entry) => (
                  <ExpertCard
                    key={entry.roleId}
                    entry={entry}
                    tab={tab}
                    text={text}
                    sourceText={t.settings.roles.card.source}
                    rolePacksByRoleId={rolePacksByRoleId}
                    busyRolePackId={busyRolePackId}
                    onRetryMissingSkills={(roleId) => { void runRolePackAction(roleId, retryRolePackMissingSkills); }}
                    onDetail={() => openExpertRoleDetail(entry.roleId)}
                    onInvite={(seed) => invite(entry, seed)}
                  />
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
    </div>
  );
};
