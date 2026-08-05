import React from 'react';
import { ArrowRight, BarChart3, Gamepad2, HardDrive, Search } from 'lucide-react';
import type { SessionWorkbenchSnapshot } from '@shared/contract/sessionWorkspace';
import { PLAIN_CHAT_SUMMARY_LABEL } from '@shared/contract/sessionWorkspace';
import { useI18n } from '../../../hooks/useI18n';
import type { Translations } from '../../../i18n';
import { formatRelativeTime } from '../../../utils/i18nTime';
import { isBlankNewSession, type SessionWithMeta } from '../../../stores/sessionStore';
import { PlanetSphere } from '../../brand/PlanetSphere';
import { usePinnedLibraryItems } from './ChatInput/PinnedLibraryChips';

type ResumableSession = Pick<
  SessionWithMeta,
  'id' | 'title' | 'updatedAt' | 'messageCount' | 'turnCount' | 'isArchived' | 'status'
>;

interface SuggestionItem {
  icon: React.ElementType;
  title: string;
  description: string;
  prompt: string;
  accent: string;
  iconColor: string;
}

// 新会话任务卡：一键直出可运行/可交互产物或真实 agent 产出，第一轮不追问、即见结果。
// 文案（含 prompt 本体）随 UI 语言走 i18n：中文用户发中文 prompt，英文用户发英文 prompt。
// 用色拍板（2026-07-26 空态品牌化）：首张推荐卡 = 品牌青（--brand-primary 派生），
// 其余一律中性——此前的琥珀/蓝/紫/绿分类色让首屏像通用模板，品牌无处识别。
export function buildDefaultSuggestions(t: Translations): SuggestionItem[] {
  return [
    {
      icon: Gamepad2,
      ...t.chat.suggestions.game,
      accent: 'bg-[color-mix(in_srgb,var(--brand-primary)_12%,transparent)] border-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]',
      iconColor: 'text-brand',
    },
    {
      icon: BarChart3,
      ...t.chat.suggestions.chart,
      accent: 'bg-[color-mix(in_srgb,var(--text-primary)_3%,transparent)] border-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]',
      iconColor: 'text-zinc-400',
    },
    {
      icon: Search,
      ...t.chat.suggestions.briefing,
      accent: 'bg-[color-mix(in_srgb,var(--text-primary)_3%,transparent)] border-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]',
      iconColor: 'text-zinc-400',
    },
    {
      icon: HardDrive,
      ...t.chat.suggestions.disk,
      accent: 'bg-[color-mix(in_srgb,var(--text-primary)_3%,transparent)] border-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]',
      iconColor: 'text-zinc-400',
    },
  ];
}

// 新会话欢迎页（示例建议 + 工作区上下文标签）——不是通用空态，别并进 primitives/EmptyState
//
// session：当前会话。空态首屏走到这里时，只有它是真·新会话才配渲染欢迎页；冷启动自动
// 恢复的历史会话恰好没有内容时，必须明说「你在哪条会话里」——否则与真新会话像素级不可
// 区分，用户以为自己新开了一条，首条消息却接在昨晚那条后面（2026-08-01 事故）。
// 判定刻意放在本组件内而不是调用方：那样这条决策才被组件单测覆盖，不会被一次误删接线
// 静默退回事故行为。
export const NewSessionWelcome: React.FC<{
  onSend: (message: string) => void;
  workingDirectory?: string | null;
  workbenchSnapshot?: SessionWorkbenchSnapshot | null;
  session?: ResumableSession | null;
}> = ({
  onSend,
  workingDirectory,
  workbenchSnapshot,
  session,
}) => {
  const { t } = useI18n();
  const suggestions = buildDefaultSuggestions(t);
  // 带着资料进来的会话不摆通用模板卡（贪吃蛇/图表与带入材料无关，真机 2026-08-05
  // 「上方的示意和带入的材料没关系」）；后续可升级为按材料生成的建议。
  const { pinnedItems } = usePinnedLibraryItems(session?.id ?? null);
  const showSuggestions = pinnedItems.length === 0;
  const resumedSession = session && !isBlankNewSession(session) ? session : null;
  // 纯对话（无工作区）是默认形态，不必再标「空白会话」——用户反馈看不懂、是噪音。
  // 只有继承了项目/工作区上下文时才显示上下文标签（"项目会话 · name"），告诉用户这条会话带了上下文。
  const hasWorkspaceContext = Boolean(workingDirectory?.trim());
  const contextLabel = hasWorkspaceContext ? formatNewSessionContextLabel(t, workingDirectory) : null;
  const contextDetails = hasWorkspaceContext
    ? buildNewSessionContextDetails(t, workbenchSnapshot)
    : null;

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
              {resumedSession
                ? t.chat.resumedEmptyTitle.replace('{title}', resumedSession.title)
                : t.chat.welcomeTitle}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              {resumedSession
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

        {showSuggestions && <div className="grid grid-cols-2 gap-3">
          {suggestions.map((suggestion, index) => (
            <SuggestionCard
              key={suggestion.title}
              {...suggestion}
              onSend={onSend}
              delay={100 + index * 60}
            />
          ))}
        </div>}
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
  onSend: (message: string) => void;
  delay: number;
}

const SuggestionCard: React.FC<SuggestionCardProps> = ({
  icon: Icon,
  title,
  description,
  prompt,
  accent,
  iconColor,
  onSend,
  delay,
}) => {
  return (
    <button
      onClick={() => onSend(prompt)}
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
