import React from 'react';
import { ArrowRight, BarChart3, FolderOpen, Gamepad2, HardDrive, Search } from 'lucide-react';
import type { SessionWorkbenchSnapshot } from '@shared/contract/sessionWorkspace';
import { PLAIN_CHAT_SUMMARY_LABEL } from '@shared/contract/sessionWorkspace';
import { useI18n } from '../../../hooks/useI18n';
import type { Translations } from '../../../i18n';
import { NeoBrandMark } from '../sidebar/NeoBrandMark';

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
      accent: 'bg-white/[0.03] border-white/[0.08]',
      iconColor: 'text-zinc-400',
    },
    {
      icon: Search,
      ...t.chat.suggestions.briefing,
      accent: 'bg-white/[0.03] border-white/[0.08]',
      iconColor: 'text-zinc-400',
    },
    {
      icon: HardDrive,
      ...t.chat.suggestions.disk,
      accent: 'bg-white/[0.03] border-white/[0.08]',
      iconColor: 'text-zinc-400',
    },
  ];
}

// 新会话欢迎页（示例建议 + 工作区上下文标签）——不是通用空态，别并进 primitives/EmptyState
export const NewSessionWelcome: React.FC<{
  onSend: (message: string) => void;
  workingDirectory?: string | null;
  workbenchSnapshot?: SessionWorkbenchSnapshot | null;
  /** 目录选择入口（2026-07-27 批C2：侧栏「选择目录」行退役，目录选择并入新任务流程） */
  onPickDirectory?: () => void;
}> = ({
  onSend,
  workingDirectory,
  workbenchSnapshot,
  onPickDirectory,
}) => {
  const { t } = useI18n();
  const suggestions = buildDefaultSuggestions(t);
  // 纯对话（无工作区）是默认形态，不必再标「空白会话」——用户反馈看不懂、是噪音。
  // 只有继承了项目/工作区上下文时才显示上下文标签（"项目会话 · name"），告诉用户这条会话带了上下文。
  const hasWorkspaceContext = Boolean(workingDirectory?.trim());
  const contextLabel = hasWorkspaceContext ? formatNewSessionContextLabel(t, workingDirectory) : null;
  // tooltip 不再回显完整路径（内部路径如 ~/.code-agent-dev/work 会原样漏给用户）；
  // 真实路径在点开目录选择器时自然可见，那是「选路径」的语境，合适。
  const contextTitle = t.sidebar.selectDirectoryTitle;
  const contextDetails = hasWorkspaceContext
    ? buildNewSessionContextDetails(t, workbenchSnapshot)
    : null;

  return (
    <div className="h-full flex flex-col items-center justify-center px-6 py-12">
      {/* max-w-3xl(768px) 与消息流/输入框同宽（2026-07-27 拍板）：首发消息后内容列不再跳 96px */}
      <div className="w-full max-w-3xl animate-fade-in">
        {/* 品牌标入场（2026-07-26 空态品牌化）：用户第一眼页面此前没有任何品牌触点 */}
        <NeoBrandMark size={28} showWordmark={false} className="mb-4" />
        <div className="mb-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-zinc-100">{t.chat.welcomeTitle}</h1>
            <p className="mt-1 text-sm text-zinc-500">
              {t.chat.welcomeSubtitle}
            </p>
          </div>
          {/* 目录选择并入新任务流程：标签从只读展示升级为换目录入口。
              未设目录时是引导态「选择目录」；已设时显示项目名，点击可换。 */}
          {onPickDirectory ? (
            <button /* ds-allow:button: 欢迎页目录 chip（11px 行内胶囊，与只读上下文标签同形态），Button primitive 无对应微尺寸变体 */
              type="button"
              onClick={onPickDirectory}
              title={contextTitle}
              data-testid="welcome-directory-chip"
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-white/[0.16] hover:text-zinc-200"
            >
              <FolderOpen className="h-3 w-3" />
              {contextLabel ?? t.sidebar.selectDirectory}
            </button>
          ) : contextLabel ? (
            <span
              title={contextTitle}
              className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] font-medium text-zinc-400"
            >
              {contextLabel}
            </span>
          ) : null}
        </div>
        {contextDetails && (
          <div className="mb-4 truncate text-[11px] text-zinc-500">
            {contextDetails}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {suggestions.map((suggestion, index) => (
            <SuggestionCard
              key={suggestion.title}
              {...suggestion}
              onSend={onSend}
              delay={100 + index * 60}
            />
          ))}
        </div>
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
  if (skillCount > 0) parts.push(`${skillCount} Skill`);
  if (connectorCount > 0) parts.push(`${connectorCount} Connector`);
  if (mcpCount > 0) parts.push(`${mcpCount} MCP`);

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
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-black/20">
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
