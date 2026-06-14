import type { CrossSessionSearchResultItem } from '@shared/ipc/types';

export type SidebarSearchScope = 'current-project' | 'all';

export interface SidebarSearchSession {
  id: string;
  projectId?: string | null;
  workingDirectory?: string | null;
}

export interface SidebarMessageSearchHit {
  sessionId: string;
  messageId?: string;
  messageIndex?: number;
  turnNumber?: number;
  snippet: string;
  messagePositionLabel: string;
  role: CrossSessionSearchResultItem['role'];
  timestamp: number;
  matchOffset?: number;
  matchCount: number;
  relevance: number;
}

export interface SidebarMessageSearchHitGroup {
  sessionId: string;
  bestHit: SidebarMessageSearchHit;
  hits: SidebarMessageSearchHit[];
}

export function stripSearchHighlightMarkers(snippet: string): string {
  return snippet.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

export function formatSidebarMessageSearchHitLabel(hit: SidebarMessageSearchHit): string {
  return `消息命中 · ${hit.snippet}`;
}

export function formatSidebarMessageSearchHitMeta(
  hit: SidebarMessageSearchHit,
  now = Date.now(),
): string {
  const items = [hit.messagePositionLabel];
  const relativeTime = formatRelativeTimestamp(hit.timestamp, now);
  if (relativeTime) {
    items.push(relativeTime);
  }
  return items.join(' · ');
}

function formatRelativeTimestamp(timestamp: number, now: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const diff = now - timestamp;
  if (!Number.isFinite(diff) || diff < 0) return '';
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  return `${Math.floor(days / 30)}月前`;
}

function formatMessagePositionLabel(
  messageIndex: number | undefined,
  turnNumber: number | undefined,
): string {
  if (typeof turnNumber === 'number' && turnNumber > 0) {
    return `第 ${turnNumber} 轮`;
  }
  if (typeof messageIndex !== 'number' || messageIndex < 0) {
    return '消息';
  }
  return `消息 ${messageIndex + 1}`;
}

function getProjectSearchKey(session: SidebarSearchSession | undefined): string | null {
  const projectId = session?.projectId?.trim();
  if (projectId) {
    return `project:${projectId}`;
  }

  const workingDirectory = session?.workingDirectory?.trim();
  return workingDirectory ? `workspace:${workingDirectory}` : null;
}

export function getCurrentProjectSearchSessionIds(
  sessions: SidebarSearchSession[],
  currentSessionId: string | null | undefined,
): Set<string> {
  const current = sessions.find((session) => session.id === currentSessionId);
  const currentKey = getProjectSearchKey(current);
  if (!currentKey) {
    return new Set();
  }

  return new Set(
    sessions
      .filter((session) => getProjectSearchKey(session) === currentKey)
      .map((session) => session.id),
  );
}

export function resolveSidebarSearchScope(
  requestedScope: SidebarSearchScope,
  currentProjectSessionIds: Set<string>,
): SidebarSearchScope {
  if (requestedScope === 'current-project' && currentProjectSessionIds.size === 0) {
    return 'all';
  }
  return requestedScope;
}

function normalizeSidebarMessageSearchHit(result: CrossSessionSearchResultItem): SidebarMessageSearchHit {
  return {
    sessionId: result.sessionId,
    messageId: result.messageId,
    messageIndex: result.messageIndex,
    turnNumber: result.turnNumber,
    snippet: stripSearchHighlightMarkers(result.snippet),
    messagePositionLabel: formatMessagePositionLabel(result.messageIndex, result.turnNumber),
    role: result.role,
    timestamp: result.timestamp,
    matchOffset: result.matchOffset,
    matchCount: result.matchCount,
    relevance: result.relevance,
  };
}

function compareSidebarMessageSearchHits(
  left: SidebarMessageSearchHit,
  right: SidebarMessageSearchHit,
): number {
  if (left.relevance !== right.relevance) {
    return right.relevance - left.relevance;
  }
  return right.timestamp - left.timestamp;
}

export function buildSidebarMessageSearchHitGroups(
  results: CrossSessionSearchResultItem[],
  allowedSessionIds?: Set<string>,
  limitPerSession = 3,
): Record<string, SidebarMessageSearchHitGroup> {
  const grouped: Record<string, SidebarMessageSearchHit[]> = {};

  for (const result of results) {
    if (allowedSessionIds && !allowedSessionIds.has(result.sessionId)) {
      continue;
    }

    grouped[result.sessionId] ??= [];
    grouped[result.sessionId].push(normalizeSidebarMessageSearchHit(result));
  }

  return Object.fromEntries(
    Object.entries(grouped).map(([sessionId, hits]) => {
      const sortedHits = hits
        .sort(compareSidebarMessageSearchHits)
        .slice(0, Math.max(1, limitPerSession));
      return [sessionId, {
        sessionId,
        bestHit: sortedHits[0],
        hits: sortedHits,
      }];
    }),
  );
}

export function buildSidebarMessageSearchHitMap(
  results: CrossSessionSearchResultItem[],
  allowedSessionIds?: Set<string>,
): Record<string, SidebarMessageSearchHit> {
  return Object.fromEntries(
    Object.entries(buildSidebarMessageSearchHitGroups(results, allowedSessionIds, 1))
      .map(([sessionId, group]) => [sessionId, group.bestHit]),
  );
}
