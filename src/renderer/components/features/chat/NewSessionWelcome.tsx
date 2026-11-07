import React, { useEffect, useState } from 'react';
import { ArrowRight, CalendarCheck, ClipboardList, FileSpreadsheet, Radar } from 'lucide-react';
import type { SessionWorkbenchSnapshot } from '@shared/contract/sessionWorkspace';
import { PLAIN_CHAT_SUMMARY_LABEL } from '@shared/contract/sessionWorkspace';
import { useI18n } from '../../../hooks/useI18n';
import type { Translations } from '../../../i18n';
import { formatRelativeTime } from '../../../utils/i18nTime';
import { isBlankNewSession, type SessionWithMeta } from '../../../stores/sessionStore';
import { DomainInvokeError } from '../../../services/ipcService';
import { acceptWakeProposal, listRoles, listWakeProposals } from '../../../services/rolesClient';
import { PlanetSphere } from '../../brand/PlanetSphere';
import { resolveRoleIcon } from '../shared/RoleIcon';
import { usePinnedLibraryItems } from './ChatInput/PinnedLibraryChips';
import { resolveBannerRoleId } from './RoleFirstWakeCard';

type ResumableSession = Pick<
  SessionWithMeta,
  'id' | 'title' | 'updatedAt' | 'messageCount' | 'turnCount' | 'isArchived' | 'status' | 'metadata' | 'origin'
>;

interface SuggestionItem {
  icon: React.ElementType;
  title: string;
  description: string;
  prompt: string;
  accent: string;
  iconColor: string;
  wakeProposalTitle?: string;
}

// 建议卡的中性用色（2026-07-26 拍板：除首张推荐外一律中性），角色建议卡也沿用同一档。
const NEUTRAL_CARD_ACCENT = 'bg-[color-mix(in_srgb,var(--text-primary)_3%,transparent)] border-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]';
const BRAND_CARD_ACCENT = 'bg-[color-mix(in_srgb,var(--brand-primary)_12%,transparent)] border-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]';

// 新会话任务卡：一键直出职场交付物（周报/纪要/分析/简报），第一轮不追问、即见结果。
// 文案（含 prompt 本体）随 UI 语言走 i18n：中文用户发中文 prompt，英文用户发英文 prompt。
// 用色拍板（2026-07-26 空态品牌化）：首张推荐卡 = 品牌青（--brand-primary 派生），
// 其余一律中性——此前的琥珀/蓝/紫/绿分类色让首屏像通用模板，品牌无处识别。
export function buildDefaultSuggestions(t: Translations): SuggestionItem[] {
  return [
    {
      icon: CalendarCheck,
      ...t.chat.suggestions.weeklyReport,
      accent: BRAND_CARD_ACCENT,
      iconColor: 'text-brand',
    },
    {
      icon: ClipboardList,
      ...t.chat.suggestions.meetingNotes,
      accent: NEUTRAL_CARD_ACCENT,
      iconColor: 'text-zinc-400',
    },
    {
      icon: FileSpreadsheet,
      ...t.chat.suggestions.sheetAnalysis,
      accent: NEUTRAL_CARD_ACCENT,
      iconColor: 'text-zinc-400',
    },
    {
      icon: Radar,
      ...t.chat.suggestions.competitorBrief,
      accent: NEUTRAL_CARD_ACCENT,
      iconColor: 'text-zinc-400',
    },
  ];
}

// 专家（角色绑定）会话的空态：标题写专家名、副标题直说下一步，起手卡只摆角色既有
// 数据里的原话（醒来提议的 title/prompt、agent 定义里的快捷开场 prompt，都不在代码里
// 编造），上限四张，两边都没有就一张不摆。判定依据与 RoleFirstWakeThreadBanner 同源
// （resolveBannerRoleId：expertThread 标记 / first_wake origin），不另立第二份判据、
// 不加新字段。
interface ExpertRoleInfo {
  /** 展示名（RolePanelEntry.displayName；缺省回退 roleId，同 RoleFirstWakeCard 的兜底） */
  name: string;
  cards: SuggestionItem[];
}

function buildExpertRoleCards(
  entryIcon: string | undefined,
  quickPrompts: readonly string[],
  proposals: ReadonlyArray<{ title: string; prompt: string }>,
): SuggestionItem[] {
  const icon = resolveRoleIcon(entryIcon);
  const cards: SuggestionItem[] = [
    ...proposals.map((proposal) => ({
      icon,
      title: proposal.title,
      description: '',
      prompt: proposal.prompt,
      accent: NEUTRAL_CARD_ACCENT,
      iconColor: 'text-zinc-400',
      wakeProposalTitle: proposal.title,
    })),
    ...quickPrompts.map((prompt) => ({
      icon,
      title: prompt,
      description: '',
      prompt,
      accent: NEUTRAL_CARD_ACCENT,
      iconColor: 'text-zinc-400',
    })),
  ];
  return cards
    .filter((card) => card.title.trim().length > 0 && card.prompt.trim().length > 0)
    .slice(0, 4);
}

// 新会话欢迎页（示例建议 + 工作区上下文标签）——不是通用空态，别并进 primitives/EmptyState
//
// session：当前会话。空态首屏走到这里时，只有它是真·新会话才配渲染欢迎页；冷启动自动
// 恢复的历史会话恰好没有内容时，必须明说「你在哪条会话里」——否则与真新会话像素级不可
// 区分，用户以为自己新开了一条，首条消息却接在昨晚那条后面（2026-08-01 事故）。
// 判定刻意放在本组件内而不是调用方：那样这条决策才被组件单测覆盖，不会被一次误删接线
// 静默退回事故行为。
//
// 专家（角色绑定）会话是第三种形态（2026-11-05 owner 返修）：标题写专家名、副标题直说
// 下一步、起手卡只摆角色既有数据里的原话（醒来提议 + 快捷开场 prompt，≤4 张；没有就
// 一张不摆）——「继续上次的会话」对刚建好的专家 thread 是自相矛盾，通用职场模板卡也
// 与专家无关。专家分支优先于 resumed 分支。
export const NewSessionWelcome: React.FC<{
  onSend: (message: string) => void;
  /**
   * FB-580（2026-11-05 真机复现）：composer 已有内容（文本/附件/chip）时点示例卡
   **不**直接发送——改走 onFillDraft 把模板追加进输入框，发送时机留给用户。
   * 缺省（不传）按空 composer 处理，保持一键直发。
   */
  isComposerOccupied?: () => boolean;
  /** FB-580：把示例模板填进 composer（不发送、不动附件与 chip）。 */
  onFillDraft?: (prompt: string) => void;
  workingDirectory?: string | null;
  workbenchSnapshot?: SessionWorkbenchSnapshot | null;
  session?: ResumableSession | null;
}> = ({
  onSend,
  isComposerOccupied,
  onFillDraft,
  workingDirectory,
  workbenchSnapshot,
  session,
}) => {
  const { t } = useI18n();
  const suggestions = buildDefaultSuggestions(t);
  const { pinnedItems } = usePinnedLibraryItems(session?.id ?? null);
  const resumedSession = session && !isBlankNewSession(session) ? session : null;
  // 专家会话判定与顶部横幅同源（expertThread 标记 / first_wake origin）。专家主 thread
  // 的标题是角色名而非「新对话」，isBlankNewSession 恒 false——它会被下面的 resumed
  // 分支接住，显示「继续上次的会话：{角色名}」+「这条会话还没有内容」，对刚建好的
  // 专家 thread 自相矛盾（2026-11-05 owner 返修）。专家分支优先于 resumed 分支。
  const expertRoleId = resolveBannerRoleId(session ?? undefined);
  const [expert, setExpert] = useState<ExpertRoleInfo | null>(null);

  useEffect(() => {
    if (!expertRoleId) {
      setExpert(null);
      return undefined;
    }
    let cancelled = false;
    // 卡片数据只取角色既有数据（醒来提议 + 快捷开场 prompt），不加模型调用、不编造。
    void Promise.all([listRoles(), listWakeProposals(expertRoleId)])
      .then(([entries, proposals]) => {
        if (cancelled) return;
        const entry = entries.find((candidate) => candidate.roleId === expertRoleId);
        setExpert({
          name: entry?.displayName?.trim() || expertRoleId,
          cards: buildExpertRoleCards(entry?.icon, entry?.quickPrompts ?? [], proposals),
        });
      })
      .catch(() => {
        // roles IPC 不可用：保底用 roleId 命名、不摆卡（展示名兜底与 RoleFirstWakeCard 一致）
        if (!cancelled) setExpert({ name: expertRoleId, cards: [] });
      });
    return () => { cancelled = true; };
  }, [expertRoleId]);
  // 纯对话（无工作区）是默认形态，不必再标「空白会话」——用户反馈看不懂、是噪音。
  // 只有继承了项目/工作区上下文时才显示上下文标签（"项目会话 · name"），告诉用户这条会话带了上下文。
  const hasWorkspaceContext = Boolean(workingDirectory?.trim());
  // 通用模板卡（周报/纪要这类）只服务「不知道干什么」的空会话：给个起点。
  // 会话一旦带了上下文——资料库材料 pin 进来、或从空间/项目进来——用户是带着目的
  // 来的，这几张与他手上的事无关的卡就是噪音（真机 2026-08-05「上方的示意和带入的
  // 材料没关系」）。2026-08-06 拍板：不做「按材料生成建议」，不为此加模型调用，
  // 有上下文就直接不摆。
  const showSuggestions = pinnedItems.length === 0 && !hasWorkspaceContext;
  const contextLabel = hasWorkspaceContext ? formatNewSessionContextLabel(t, workingDirectory) : null;
  const contextDetails = hasWorkspaceContext
    ? buildNewSessionContextDetails(t, workbenchSnapshot)
    : null;
  // FB-580：示例卡是给「还没开工」的人的一键起点；用户已经开始打字/挂附件/摆 chip 时，
  // 点卡绝不替他发送或丢弃草稿——模板进输入框（空行分隔），何时发送由他决定。
  // 判定放在本组件内而不是调用方：这样这条决策才被组件单测覆盖（同 isBlankNewSession
  // 的立规理由），不会被一次误删接线静默退回「点卡即重活开跑」的事故行为。
  const activatePrompt = (prompt: string) => {
    if (isComposerOccupied?.()) {
      onFillDraft?.(prompt);
      return;
    }
    onSend(prompt);
  };
  const removeWakeProposalCard = (title: string) => {
    setExpert((current) => current ? {
      ...current,
      cards: current.cards.filter((card) => card.wakeProposalTitle !== title),
    } : current);
  };
  const handleSuggestionActivate = (prompt: string, wakeProposalTitle?: string) => {
    if (!expertRoleId || !wakeProposalTitle) {
      activatePrompt(prompt);
      return;
    }
    // 与 RoleWakeProposalsCard 同一 accept 路径：先让 host 原子消费 pending 提议，
    // 再使用 host 返回的 prompt 走原有一键直发 / FB-580 填草稿行为。
    void acceptWakeProposal(expertRoleId, wakeProposalTitle)
      .then((accepted) => {
        removeWakeProposalCard(wakeProposalTitle);
        if (!accepted) return;
        activatePrompt(accepted.prompt);
      })
      .catch((error) => {
        if (error instanceof DomainInvokeError && error.code === 'NOT_FOUND') {
          removeWakeProposalCard(wakeProposalTitle);
          return;
        }
        throw error;
      });
  };

  return (
    <div className="h-full flex flex-col items-center justify-center px-6 py-12">
      {/* max-w-3xl(768px) 与消息流/输入框同宽（2026-07-27 拍板）：首发消息后内容列不再跳 96px */}
      <div className="w-full max-w-3xl animate-fade-in">
        {/* 品牌区（2026-08-02 星球品牌升级拍板，同日修订）：42px 慢转地球（24s/周，
            静态 fx）单独作主视觉——不与 NeoBrandMark 并排（双标并置生硬，且品牌标
            在侧栏常驻，此处重复）。建议卡维持原样（用户否掉"航线"包装）；整页不加
            星点纹理（舷窗原则：阅读区保持干净）。reduced-motion 停转由 PlanetSphere
            内建 CSS 兜底，此处零处理。 */}
        <div className="mb-4">
          <PlanetSphere kind="earth" spinSeconds={24} glowColor="rgba(96,165,250,.20)" size={42} interactive />
        </div>
        <div className="mb-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-zinc-100" data-testid="chat-welcome-title">
              {expertRoleId
                ? (expert?.name ?? expertRoleId)
                : resumedSession
                  ? t.chat.resumedEmptyTitle.replace('{title}', resumedSession.title)
                  : t.chat.welcomeTitle}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              {expertRoleId
                ? t.chat.expertEmptySubtitle
                : resumedSession
                  ? t.chat.resumedEmptySubtitle.replace('{time}', formatRelativeTime(t, resumedSession.updatedAt))
                  : t.chat.welcomeSubtitle}
            </p>
          </div>
          {/* 上下文标签只读展示（2026-07-29：目录 chip 入口已删——
              目录选择收进侧栏「项目」区的新建项目流程与项目行 ⋯ 菜单）。 */}
          {contextLabel && (
            <span
              className="shrink-0 rounded-md border border-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] bg-[color-mix(in_srgb,var(--text-primary)_3%,transparent)] px-2 py-1 text-[11px] font-medium text-zinc-400"
            >
              {contextLabel}
            </span>
          )}
        </div>
        {contextDetails && (
          <div className="mb-4 truncate text-[11px] text-zinc-500">
            {contextDetails}
          </div>
        )}

        {showSuggestions && (expertRoleId ? (
          // 专家空态：只摆角色自己的建议（醒来提议 + 快捷开场 prompt，≤4 张，同一
          // 一键直发 / 填草稿行为）；角色没有任何既有建议时一张不摆，绝不回退到
          // 与专家无关的通用职场模板卡。
          expert !== null && expert.cards.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {expert.cards.map((card, index) => (
                <SuggestionCard
                  key={`${card.prompt}-${index}`}
                  {...card}
                  onActivate={handleSuggestionActivate}
                  delay={100 + index * 60}
                />
              ))}
            </div>
          )
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {suggestions.map((suggestion, index) => (
              <SuggestionCard
                key={suggestion.title}
                {...suggestion}
                onActivate={handleSuggestionActivate}
                delay={100 + index * 60}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

function formatNewSessionContextLabel(t: Translations, workingDirectory?: string | null): string {
  const trimmed = workingDirectory?.trim();
  if (!trimmed) {
    return t.chat.blankSession;
  }
  const parts = trimmed.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] || trimmed;
  return t.chat.projectSession.replace('{name}', name);
}

function buildNewSessionContextDetails(t: Translations, snapshot?: SessionWorkbenchSnapshot | null): string | null {
  if (!snapshot) {
    return null;
  }

  const parts: string[] = [];
  const summary = snapshot.summary?.trim();
  if (summary && summary !== PLAIN_CHAT_SUMMARY_LABEL) {
    parts.push(summary);
  }

  const recentTools = (snapshot.recentToolNames ?? [])
    .map((toolName) => toolName.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (recentTools.length > 0) {
    const remaining = Math.max(0, (snapshot.recentToolNames?.length ?? 0) - recentTools.length);
    parts.push(t.chat.recentTools.replace('{names}', `${recentTools.join(', ')}${remaining > 0 ? ` +${remaining}` : ''}`));
  }

  const skillCount = snapshot.skillIds?.length ?? 0;
  const connectorCount = snapshot.connectorIds?.length ?? 0;
  const mcpCount = snapshot.mcpServerIds?.length ?? 0;
  if (skillCount > 0) parts.push(t.chat.skillCount.replace('{count}', String(skillCount)));
  if (connectorCount > 0) parts.push(t.chat.connectorCount.replace('{count}', String(connectorCount)));
  if (mcpCount > 0) parts.push(t.chat.mcpCount.replace('{count}', String(mcpCount)));

  return parts.length > 0 ? t.chat.inheritedPrefix.replace('{parts}', parts.join(' · ')) : null;
}

interface SuggestionCardProps {
  icon: React.ElementType;
  title: string;
  description: string;
  prompt: string;
  accent: string;
  iconColor: string;
  wakeProposalTitle?: string;
  onActivate: (prompt: string, wakeProposalTitle?: string) => void;
  delay: number;
}

const SuggestionCard: React.FC<SuggestionCardProps> = ({
  icon: Icon,
  title,
  description,
  prompt,
  accent,
  iconColor,
  wakeProposalTitle,
  onActivate,
  delay,
}) => {
  return (
    <button
      onClick={() => onActivate(prompt, wakeProposalTitle)}
      className={`group relative min-h-[128px] rounded-lg border p-4 text-left ${accent}
                  transition-colors duration-200 hover:border-border-hover hover:bg-surface-hover
                  animate-fade-in-up`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] bg-black/20">
          <Icon className={`h-4 w-4 ${iconColor}`} />
        </div>
        <ArrowRight className="h-4 w-4 text-zinc-600 transition-colors group-hover:text-zinc-300" />
      </div>

      <div className="text-sm font-medium text-zinc-100">
        {title}
      </div>
      <div className="mt-1 text-xs leading-relaxed text-zinc-500">
        {description}
      </div>
    </button>
  );
};
