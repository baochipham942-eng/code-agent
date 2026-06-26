// ============================================================================
// Workspace Activity Search Service - Unified retrieval over desktop + office artifacts
// ============================================================================

import { getDesktopActivityUnderstandingService } from './desktopActivityUnderstandingService';
import type { DesktopActivitySemanticMatch } from '../../shared/contract';
import { estimateTokens } from '../context/tokenOptimizer';
import { getWorkspaceArtifactIndexService } from './workspaceArtifactIndexService';

export type WorkspaceActivitySource = 'desktop' | 'mail' | 'calendar' | 'reminders';

export interface WorkspaceActivitySearchItem {
  id: string;
  source: WorkspaceActivitySource;
  title: string;
  snippet: string;
  score: number;
  timestampMs?: number | null;
  metadata: Record<string, unknown>;
}

export interface WorkspaceActivitySearchOptions {
  sinceHours?: number;
  limit?: number;
  refreshDesktop?: boolean;
  refreshArtifacts?: boolean;
  sources?: WorkspaceActivitySource[];
  account?: string;
  mailboxes?: string[];
  mailboxLimit?: number;
  calendar?: string;
  reminderList?: string;
  includeCompletedReminders?: boolean;
  minScore?: number;
  contextMaxTokens?: number;
  contextMaxItems?: number;
  contextMaxPerSource?: Partial<Record<WorkspaceActivitySource, number>>;
}

export interface WorkspaceActivitySearchResult {
  items: WorkspaceActivitySearchItem[];
  warnings: string[];
  countsBySource: Record<string, number>;
}

// ---- Workspace Activity Feedback ----

export type WorkspaceActivityFeedbackStatus = 'accepted' | 'completed' | 'dismissed';

interface WorkspaceActivityFeedbackEntry {
  status: WorkspaceActivityFeedbackStatus;
  sessionId: string;
  source: string;
  updatedAtMs: number;
}

const workspaceActivityFeedbackMap = new Map<string, WorkspaceActivityFeedbackEntry>();

export function recordWorkspaceActivityFeedback(
  itemId: string,
  status: WorkspaceActivityFeedbackStatus,
  meta?: { sessionId?: string; source?: string },
): void {
  workspaceActivityFeedbackMap.set(itemId, {
    status,
    sessionId: meta?.sessionId || 'default',
    source: meta?.source || 'unknown',
    updatedAtMs: Date.now(),
  });
}

export function getWorkspaceActivityFeedback(
  itemId: string,
): WorkspaceActivityFeedbackEntry | null {
  return workspaceActivityFeedbackMap.get(itemId) || null;
}

export function clearWorkspaceActivityFeedback(itemId: string): void {
  workspaceActivityFeedbackMap.delete(itemId);
}

// ---- Constants ----

const ALL_SOURCES: WorkspaceActivitySource[] = ['desktop', 'mail', 'calendar', 'reminders'];
const OFFICE_SOURCES: WorkspaceActivitySource[] = ['mail', 'calendar', 'reminders'];
const DEFAULT_LIMIT = 8;
const DEFAULT_SINCE_HOURS = 24;
const DEFAULT_CONTEXT_MAX_TOKENS = 220;
const DEFAULT_CONTEXT_MAX_ITEMS = 3;
const DEFAULT_CONTEXT_MAX_PER_SOURCE: Record<WorkspaceActivitySource, number> = {
  desktop: 1,
  mail: 1,
  calendar: 1,
  reminders: 1,
};
const GENERIC_QUERY_TERMS = new Set([
  '继续',
  '推进',
  '处理',
  '优化',
  '一下',
  '帮我',
  '这个',
  '那个',
  '相关',
  '事情',
  '任务',
  '工作',
  '问题',
  '看看',
  '整理',
  'follow',
  'followup',
  'continue',
  'update',
  'issue',
  'task',
  'work',
  'thing',
  'stuff',
]);
const GENERIC_CHINESE_QUERY_PATTERN = /(继续|推进|处理|优化|一下|帮我|这个|那个|相关|事情|任务|工作|问题|看看|整理|跟进|做|再|把|先|一下子|继续做一下|继续推进一下)/g;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sourcePriority(source: WorkspaceActivitySource): number {
  switch (source) {
    case 'desktop':
      return 0;
    case 'mail':
      return 1;
    case 'calendar':
      return 2;
    case 'reminders':
      return 3;
  }
}

function buildQueryTerms(query: string): string[] {
  const normalized = normalizeText(query);
  const tokens = normalized
    .split(/[\s,，。/|:：;；()[\]{}"'`]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  return Array.from(new Set([normalized, ...tokens]));
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function extractMeaningfulQueryTerms(query: string): string[] {
  const normalized = normalizeText(query);
  if (
    containsCjk(normalized)
    && !/[a-z0-9#/_-]/i.test(normalized)
    && normalized.replace(GENERIC_CHINESE_QUERY_PATTERN, '').trim().length < 2
  ) {
    return [];
  }

  const baseTerms = buildQueryTerms(query);
  const candidates = containsCjk(normalized)
    ? [normalized, ...baseTerms]
    : baseTerms;

  return Array.from(new Set(
    candidates.filter((term) => {
      const trimmed = term.trim();
      if (!trimmed) return false;
      if (GENERIC_QUERY_TERMS.has(trimmed)) return false;
      if (containsCjk(trimmed)) {
        return trimmed.length >= 2;
      }
      return trimmed.length >= 3;
    }),
  ));
}

function formatDesktopMatch(match: DesktopActivitySemanticMatch): WorkspaceActivitySearchItem {
  return {
    id: `desktop:${match.summary.sliceKey}`,
    source: 'desktop',
    title: match.summary.summary,
    snippet: match.snippet,
    score: Math.min(0.99, Math.max(0.4, match.score)),
    timestampMs: match.summary.lastCapturedAtMs,
    metadata: {
      sliceKey: match.summary.sliceKey,
      fromMs: match.summary.fromMs,
      toMs: match.summary.toMs,
      topApps: match.summary.topApps,
      salientSubjects: match.summary.salientSubjects,
      domains: match.summary.domains,
    },
  };
}

async function searchDesktop(query: string, sinceHours: number, limit: number): Promise<WorkspaceActivitySearchItem[]> {
  const matches = await getDesktopActivityUnderstandingService().searchSummaries(query, {
    sinceHours,
    limit,
  });
  return matches.map(formatDesktopMatch);
}

export function formatWorkspaceActivityTimestamp(timestampMs: number | null | undefined): string {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return '时间未知';
  return new Date(timestampMs).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatWorkspaceActivitySearchItem(
  item: WorkspaceActivitySearchItem,
  index: number,
): string {
  const mergedSources = getMergedSources(item);
  const when = formatWorkspaceActivityTimestamp(item.timestampMs);
  const scope = item.source === 'desktop'
    ? `时间片 ${when}`
    : when === '时间未知'
      ? item.source
      : when;

  return `${index + 1}. [${mergedSources.join('+')}] [${item.score.toFixed(2)}] ${item.title}\n   ${scope}\n   ${item.snippet}`;
}

export function normalizeWorkspaceSearchQuery(rawQuery: string): string | null {
  const normalized = rawQuery
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length < 4) {
    return null;
  }

  return normalized.slice(0, 180);
}

function countMeaningfulTermMatches(
  item: WorkspaceActivitySearchItem,
  terms: string[],
): number {
  if (terms.length === 0) return 0;
  const haystack = normalizeText(`${item.title}\n${item.snippet}`);
  let matches = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      matches++;
    }
  }
  return matches;
}

function normalizeThreadSubject(value: string): string {
  let normalized = normalizeText(value);
  while (/^(re|fw|fwd)\s*:\s*/i.test(normalized)) {
    normalized = normalized.replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
  }
  return normalized;
}

function getItemMatchingText(item: WorkspaceActivitySearchItem): string {
  const metadata = item.metadata || {};
  const attachmentNames = Array.isArray(metadata.attachmentNames)
    ? metadata.attachmentNames.filter((name): name is string => typeof name === 'string')
    : [];
  const threadSubject = typeof metadata.threadSubject === 'string' ? metadata.threadSubject : '';
  const notesPreview = typeof metadata.notesPreview === 'string' ? metadata.notesPreview : '';
  const bodyPreview = typeof metadata.bodyPreview === 'string' ? metadata.bodyPreview : '';
  return normalizeText([
    item.title,
    item.snippet,
    threadSubject,
    notesPreview,
    bodyPreview,
    ...attachmentNames,
  ].filter(Boolean).join('\n'));
}

function getItemMergeAnchors(item: WorkspaceActivitySearchItem): string[] {
  const metadata = item.metadata || {};
  const anchors = new Set<string>();
  const threadKey = typeof metadata.threadKey === 'string' ? metadata.threadKey : '';
  const threadSubject = typeof metadata.threadSubject === 'string' ? metadata.threadSubject : '';
  const normalizedTitle = normalizeThreadSubject(item.title);

  if (threadKey) {
    anchors.add(`thread:${normalizeText(threadKey)}`);
  }
  if (threadSubject) {
    anchors.add(`thread:${normalizeThreadSubject(threadSubject)}`);
  }
  if (normalizedTitle.length >= 6) {
    anchors.add(`title:${normalizedTitle}`);
  }

  return Array.from(anchors);
}

function shouldMergeOfficeItems(
  left: WorkspaceActivitySearchItem,
  right: WorkspaceActivitySearchItem,
  queryTerms: string[],
): boolean {
  if (!OFFICE_SOURCES.includes(left.source) || !OFFICE_SOURCES.includes(right.source)) {
    return false;
  }

  const leftAnchors = new Set(getItemMergeAnchors(left));
  const rightAnchors = getItemMergeAnchors(right);
  for (const anchor of rightAnchors) {
    if (leftAnchors.has(anchor)) {
      return true;
    }
  }

  if (queryTerms.length === 0) {
    return false;
  }

  const leftText = getItemMatchingText(left);
  const rightText = getItemMatchingText(right);
  const sharedTerms = queryTerms.filter((term) => leftText.includes(term) && rightText.includes(term));

  if (sharedTerms.length === 0) {
    return false;
  }

  if (left.source !== right.source) {
    return true;
  }

  return sharedTerms.length >= 2;
}

function getMergedSources(item: WorkspaceActivitySearchItem): WorkspaceActivitySource[] {
  const merged = Array.isArray(item.metadata.mergedSources)
    ? item.metadata.mergedSources.filter((source): source is WorkspaceActivitySource => typeof source === 'string' && ALL_SOURCES.includes(source as WorkspaceActivitySource))
    : [];
  const sources = merged.length > 0 ? merged : [item.source];
  return Array.from(new Set(sources)).sort((left, right) => sourcePriority(left) - sourcePriority(right));
}

function mergeOfficeActivityItems(
  items: WorkspaceActivitySearchItem[],
  queryTerms: string[],
): WorkspaceActivitySearchItem[] {
  const desktopItems = items.filter((item) => item.source === 'desktop');
  const officeItems = items.filter((item) => OFFICE_SOURCES.includes(item.source));

  if (officeItems.length <= 1) {
    return [...desktopItems, ...officeItems];
  }

  const visited = new Set<number>();
  const mergedOfficeItems: WorkspaceActivitySearchItem[] = [];

  for (let index = 0; index < officeItems.length; index++) {
    if (visited.has(index)) continue;

    const queue = [index];
    visited.add(index);
    const component: WorkspaceActivitySearchItem[] = [];

    while (queue.length > 0) {
      const currentIndex = queue.shift()!;
      const currentItem = officeItems[currentIndex];
      component.push(currentItem);

      for (let candidateIndex = 0; candidateIndex < officeItems.length; candidateIndex++) {
        if (visited.has(candidateIndex)) continue;
        if (!shouldMergeOfficeItems(currentItem, officeItems[candidateIndex], queryTerms)) continue;
        visited.add(candidateIndex);
        queue.push(candidateIndex);
      }
    }

    if (component.length === 1) {
      mergedOfficeItems.push(component[0]);
      continue;
    }

    const rankedComponent = [...component].sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if ((right.timestampMs || 0) !== (left.timestampMs || 0)) return (right.timestampMs || 0) - (left.timestampMs || 0);
      return sourcePriority(left.source) - sourcePriority(right.source);
    });
    const primary = rankedComponent[0];
    const relatedItems = rankedComponent.slice(1);
    const mergedSources = Array.from(new Set(rankedComponent.map((item) => item.source)))
      .sort((left, right) => sourcePriority(left) - sourcePriority(right));
    const relationText = relatedItems
      .slice(0, 3)
      .map((item) => `[${item.source}] ${item.title}`)
      .join('；');

    mergedOfficeItems.push({
      ...primary,
      score: Math.min(0.99, primary.score + Math.min(0.03 * relatedItems.length, 0.09)),
      snippet: relationText
        ? `${primary.snippet} 关联线索：${relationText}`
        : primary.snippet,
      metadata: {
        ...primary.metadata,
        mergedSources,
        mergedCount: rankedComponent.length,
        relatedItems: relatedItems.map((item) => ({
          id: item.id,
          source: item.source,
          title: item.title,
          timestampMs: item.timestampMs ?? null,
        })),
      },
    });
  }

  return [...desktopItems, ...mergedOfficeItems];
}

function selectWorkspaceContextItems(
  items: WorkspaceActivitySearchItem[],
  terms: string[],
  options: Required<Pick<WorkspaceActivitySearchOptions, 'contextMaxTokens' | 'contextMaxItems'>> & {
    contextMaxPerSource: Record<WorkspaceActivitySource, number>;
    minScore: number;
  },
): WorkspaceActivitySearchItem[] {
  const ranked = [...items].sort((left, right) => {
    const leftMatches = countMeaningfulTermMatches(left, terms);
    const rightMatches = countMeaningfulTermMatches(right, terms);
    if (rightMatches !== leftMatches) return rightMatches - leftMatches;
    if (right.score !== left.score) return right.score - left.score;
    return (right.timestampMs || 0) - (left.timestampMs || 0);
  });

  const selected: WorkspaceActivitySearchItem[] = [];
  const sourceCounts: Record<WorkspaceActivitySource, number> = {
    desktop: 0,
    mail: 0,
    calendar: 0,
    reminders: 0,
  };
  let usedTokens = estimateTokens('当前用户请求和最近工作区活动存在以下相关线索，可优先复用而不是从零开始：');

  for (const item of ranked) {
    if (selected.length >= options.contextMaxItems) break;
    if (sourceCounts[item.source] >= options.contextMaxPerSource[item.source]) continue;

    const termMatches = countMeaningfulTermMatches(item, terms);
    const allowSemanticOnly = item.source === 'desktop' && item.score >= Math.max(options.minScore + 0.18, 0.78);
    if (termMatches === 0 && !allowSemanticOnly) continue;

    const candidateText = formatWorkspaceActivitySearchItem(item, selected.length);
    const candidateTokens = estimateTokens(candidateText);
    if (selected.length > 0 && usedTokens + candidateTokens > options.contextMaxTokens) {
      continue;
    }
    if (selected.length === 0 && candidateTokens > options.contextMaxTokens) {
      continue;
    }

    selected.push(item);
    sourceCounts[item.source] += 1;
    usedTokens += candidateTokens;
  }

  return selected;
}

export async function searchWorkspaceActivity(
  query: string,
  options: WorkspaceActivitySearchOptions = {},
): Promise<WorkspaceActivitySearchResult> {
  const normalizedQuery = normalizeWorkspaceSearchQuery(query);
  if (!normalizedQuery) {
    return {
      items: [],
      warnings: [],
      countsBySource: {},
    };
  }

  const sinceHours = Math.max(1, options.sinceHours || DEFAULT_SINCE_HOURS);
  const limit = Math.max(1, options.limit || DEFAULT_LIMIT);
  const sources = (options.sources && options.sources.length > 0)
    ? options.sources
    : ALL_SOURCES;
  const meaningfulTerms = extractMeaningfulQueryTerms(normalizedQuery);
  const warnings: string[] = [];
  const items: WorkspaceActivitySearchItem[] = [];

  if (sources.includes('desktop') && options.refreshDesktop !== false) {
    await getDesktopActivityUnderstandingService().refreshRecentActivity({
      lookbackHours: Math.max(sinceHours, 6),
    });
  }

  if (sources.includes('desktop')) {
    try {
      const desktopItems = await searchDesktop(normalizedQuery, sinceHours, limit);
      items.push(...desktopItems);
    } catch (error) {
      warnings.push(`desktop: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const officeSources = sources.filter((source): source is 'mail' | 'calendar' | 'reminders' => source !== 'desktop');
  if (officeSources.length > 0) {
    try {
      const artifactIndex = getWorkspaceArtifactIndexService();
      if (options.refreshArtifacts !== false) {
        const refreshRun = await artifactIndex.refreshRecentArtifacts();
        warnings.push(...refreshRun.warnings);
      }

      const artifactResult = artifactIndex.searchArtifacts(normalizedQuery, {
        limit,
        sinceHours,
        sources: officeSources,
        account: options.account,
        mailboxes: options.mailboxes,
        calendar: options.calendar,
        reminderList: options.reminderList,
        includeCompletedReminders: options.includeCompletedReminders,
      });

      warnings.push(...artifactResult.warnings);
      items.push(...artifactResult.items.map((item) => ({
        id: item.id,
        source: item.sourceKind,
        title: item.title,
        snippet: item.snippet,
        score: item.score,
        timestampMs: item.timestampMs,
        metadata: item.metadata,
      } satisfies WorkspaceActivitySearchItem)));
    } catch (error) {
      warnings.push(`workspace-artifact-index: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const minScore = Math.max(0, options.minScore || 0);
  const mergedItems = mergeOfficeActivityItems(items, meaningfulTerms);
  const filteredItems = mergedItems
    .filter((item) => item.score >= minScore)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return (right.timestampMs || 0) - (left.timestampMs || 0);
    })
    .slice(0, limit);

  const filteredCountsBySource: Record<string, number> = {
    desktop: 0,
    mail: 0,
    calendar: 0,
    reminders: 0,
  };
  for (const item of filteredItems) {
    for (const source of getMergedSources(item)) {
      filteredCountsBySource[source] += 1;
    }
  }

  return {
    items: filteredItems,
    warnings,
    countsBySource: filteredCountsBySource,
  };
}

export async function buildWorkspaceActivityContextBlock(
  userMessage: string,
  options: WorkspaceActivitySearchOptions = {},
): Promise<string | null> {
  const query = normalizeWorkspaceSearchQuery(userMessage);
  if (!query) {
    return null;
  }

  const meaningfulTerms = extractMeaningfulQueryTerms(query);
  if (meaningfulTerms.length === 0) {
    return null;
  }

  const result = await searchWorkspaceActivity(query, {
    sinceHours: options.sinceHours || 24,
    limit: options.limit || 5,
    refreshDesktop: options.refreshDesktop !== false,
    // 上下文注入路径默认不刷新 office artifacts（会触发 AppleScript 拉起 Mail/Calendar/Reminders）。
    // 只有调用方显式传 refreshArtifacts=true 时才刷新；显式工具（recover_recent_work 等）走别的入口。
    refreshArtifacts: options.refreshArtifacts === true,
    minScore: options.minScore || 0.52,
    sources: options.sources,
    account: options.account,
    mailboxes: options.mailboxes,
    mailboxLimit: options.mailboxLimit,
    calendar: options.calendar,
    reminderList: options.reminderList,
    includeCompletedReminders: options.includeCompletedReminders,
  });

  if (result.items.length === 0) {
    return null;
  }

  const selectedItems = selectWorkspaceContextItems(result.items, meaningfulTerms, {
    contextMaxTokens: Math.max(80, options.contextMaxTokens || DEFAULT_CONTEXT_MAX_TOKENS),
    contextMaxItems: Math.max(1, options.contextMaxItems || DEFAULT_CONTEXT_MAX_ITEMS),
    contextMaxPerSource: {
      ...DEFAULT_CONTEXT_MAX_PER_SOURCE,
      ...(options.contextMaxPerSource || {}),
    },
    minScore: options.minScore || 0.52,
  });

  if (selectedItems.length === 0) {
    return null;
  }

  const lines = [
    `当前用户请求和最近工作区活动存在以下相关线索，可优先复用而不是从零开始：`,
    ...selectedItems.map((item, index) => formatWorkspaceActivitySearchItem(item, index)),
  ];

  if (result.warnings.length > 0) {
    lines.push('部分来源读取失败：', ...result.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join('\n');
}
