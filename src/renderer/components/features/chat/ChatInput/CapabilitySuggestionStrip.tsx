import React from 'react';
import { Sparkles } from 'lucide-react';
import type { WorkbenchCapabilityRegistryItem } from '../../../../utils/workbenchCapabilityRegistry';

export interface SkillRecommendationView {
  skillName: string;
  libraryId: string;
  reason: string;
  /** mount=已安装可挂载（默认），install=未安装可从推荐目录获取 */
  action?: 'mount' | 'install';
  /** action=install 时的中文显示名 */
  displayName?: string;
  /** action=install 时的来源仓库 ID */
  repoId?: string;
}

function normalizeCapabilityText(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function getCapabilitySuggestionKindLabel(kind: WorkbenchCapabilityRegistryItem['kind']): string {
  if (kind === 'skill') return 'Skill';
  if (kind === 'connector') return 'Connector';
  return 'MCP';
}

function getCapabilitySuggestionHaystack(capability: WorkbenchCapabilityRegistryItem): string {
  const parts = [capability.id, capability.label];
  if (capability.kind === 'skill') {
    parts.push(capability.description || '', capability.source || '', capability.libraryId || '');
  }
  if (capability.kind === 'connector') {
    parts.push(capability.detail || '', capability.error || '', ...(capability.capabilities || []));
  }
  if (capability.kind === 'mcp') {
    parts.push(capability.status, capability.transport || '', capability.error || '');
  }
  parts.push(...getCapabilitySuggestionAliases(capability));
  return parts.map(normalizeCapabilityText).filter(Boolean).join(' ');
}

function getCapabilitySuggestionAliases(capability: WorkbenchCapabilityRegistryItem): string[] {
  const byId: Record<string, string[]> = {
    calendar: ['日历', '日程', '会议', '排期', 'calendar', 'schedule', 'meeting', 'event'],
    mail: ['邮件', '邮箱', '收件箱', '发邮件', 'mail', 'email', 'inbox'],
    reminders: ['提醒', '提醒事项', '待办', 'todo', 'reminder', 'reminders'],
    photos: ['照片', '相册', '图片', 'photo', 'photos', 'image'],
    github: ['github', 'git', 'repo', '仓库', '代码仓库', 'issue', 'issues', 'pr', 'pull request', 'pull requests'],
    context7: ['文档', '框架文档', '库文档', 'api docs', 'docs', 'documentation', 'latest docs'],
    playwright: ['浏览器', '网页', '页面', '点击', '表单', '截图', '验收', 'e2e', 'browser', 'web', 'test', 'screenshot'],
    fetch: ['抓取', '网页读取', '读取网页', 'fetch', 'url', 'website'],
    firecrawl: ['批量抓取', '站点抓取', 'crawl', 'crawler', 'scrape', 'scraping', 'website'],
    'brave-search': ['搜索', '网页搜索', '新闻', 'search', 'web search', 'news'],
    tavily: ['搜索', '网页搜索', '新闻', 'search', 'web search', 'news'],
    exa: ['搜索', '语义搜索', '代码搜索', 'search', 'semantic search', 'code search'],
  };

  return byId[capability.id] || [];
}

export function buildCapabilitySemanticSuggestions(
  input: string,
  capabilities: WorkbenchCapabilityRegistryItem[],
): WorkbenchCapabilityRegistryItem[] {
  const query = normalizeCapabilityText(input);
  if (query.length < 2 || query.startsWith('/')) {
    return [];
  }
  const tokens = query.split(/[\s,，。.!?;；:：/\\()[\]{}"'`]+/).filter((token) => token.length >= 2);
  if (tokens.length === 0) {
    return [];
  }

  return capabilities
    .filter((capability) => !capability.selected)
    .map((capability) => {
      const haystack = getCapabilitySuggestionHaystack(capability);
      const matchedTokens = tokens.filter((token) => haystack.includes(token));
      const labelHit = haystack.includes(query) ? 2 : 0;
      const containedAliasHit = haystack
        .split(/\s+/)
        .some((part) => part.length >= 2 && query.includes(part)) ? 1.5 : 0;
      const hasTextMatch = matchedTokens.length > 0 || labelHit > 0 || containedAliasHit > 0;
      const availabilityBoost = capability.available ? 0.25 : 0;
      return {
        capability,
        score: hasTextMatch ? matchedTokens.length + labelHit + containedAliasHit + availabilityBoost : 0,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.capability.label.localeCompare(right.capability.label))
    .map((item) => item.capability)
    .slice(0, 5);
}

interface CapabilitySuggestionStripProps {
  skillRecommendations: SkillRecommendationView[];
  capabilitySuggestions: WorkbenchCapabilityRegistryItem[];
  onSkillMount: (recommendation: SkillRecommendationView) => void;
  /** 安装未安装的推荐 skill（从来源仓库获取） */
  onSkillInstall?: (recommendation: SkillRecommendationView) => void;
  onCapabilitySelect: (capability: WorkbenchCapabilityRegistryItem) => void;
  /** 正在安装中的 skill 名称 */
  installingSkillName?: string | null;
}

export const CapabilitySuggestionStrip: React.FC<CapabilitySuggestionStripProps> = ({
  skillRecommendations,
  capabilitySuggestions,
  onSkillMount,
  onSkillInstall,
  onCapabilitySelect,
  installingSkillName,
}) => {
  if (skillRecommendations.length === 0 && capabilitySuggestions.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.025] px-2.5 py-2">
      <Sparkles className="h-3.5 w-3.5 text-fuchsia-400" />
      {skillRecommendations.map((recommendation) => (
        recommendation.action === 'install' ? (
          <button
            key={`skill-rec:${recommendation.skillName}`}
            type="button"
            disabled={installingSkillName === recommendation.skillName}
            onClick={() => onSkillInstall?.(recommendation)}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-100 hover:border-emerald-400/40 disabled:opacity-60"
            title={recommendation.reason}
          >
            <span>{installingSkillName === recommendation.skillName ? '安装中...' : '安装'}</span>
            <span className="truncate">{recommendation.displayName || recommendation.skillName}</span>
          </button>
        ) : (
          <button
            key={`skill-rec:${recommendation.skillName}`}
            type="button"
            onClick={() => onSkillMount(recommendation)}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-fuchsia-400/20 bg-fuchsia-400/10 px-2 py-1 text-[11px] text-fuchsia-100 hover:border-fuchsia-400/40"
            title={recommendation.reason}
          >
            <span>挂载</span>
            <span className="truncate">{recommendation.skillName}</span>
          </button>
        )
      ))}
      {capabilitySuggestions.map((capability) => (
        <button
          key={`capability-rec:${capability.key}`}
          type="button"
          onClick={() => onCapabilitySelect(capability)}
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-white/[0.08] bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300 hover:border-white/[0.14] hover:text-zinc-100"
          title={`${getCapabilitySuggestionKindLabel(capability.kind)}: ${capability.label}`}
        >
          <span className="text-zinc-500">{getCapabilitySuggestionKindLabel(capability.kind)}</span>
          <span className="truncate">{capability.label}</span>
        </button>
      ))}
    </div>
  );
};
