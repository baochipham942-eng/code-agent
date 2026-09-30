// pack 候选的范围匹配与打分（从 memoryEntryRuntime 拆出，god-file max-lines 门）。
// 项目记忆匹配走仓库身份键（N-MEM-PROJECTKEY）：同仓 worktree 共享记忆分区。
import type { MemoryEntry, MemoryPackRequest } from '../../shared/contract/memory';

/** 项目记忆匹配上下文：请求侧与条目侧的仓库身份键（N-MEM-PROJECTKEY）。 */
export interface ProjectMemoryMatch {
  requestKey: string | undefined;
  entryKeys: ReadonlyMap<string, string>;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function tokenizeQuery(query: string): string[] {
  const text = normalizeText(query);
  if (!text) return [];
  const tokens = text.split(/[^a-z0-9_\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return Array.from(new Set(tokens)).slice(0, 12);
}

function projectMemoryMatches(entry: MemoryEntry, match: ProjectMemoryMatch): boolean {
  if (!entry.projectPath) return true;
  const entryKey = match.entryKeys.get(entry.id);
  return Boolean(match.requestKey && entryKey && entryKey === match.requestKey);
}

export function scopeMatches(entry: MemoryEntry, request: MemoryPackRequest, match: ProjectMemoryMatch): boolean {
  if (entry.scope === 'global') return true;
  if (entry.scope === 'project') return projectMemoryMatches(entry, match);
  if (entry.scope === 'session') return Boolean(request.sessionId && entry.sessionId === request.sessionId);
  return false;
}

export function scoreMemoryEntry(entry: MemoryEntry, request: MemoryPackRequest, match: ProjectMemoryMatch, tokens: string[]): {
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];
  if (entry.status === 'active') {
    score += 25;
    reasons.push('active');
  }
  if (entry.scope === 'global') {
    score += 4;
    reasons.push('global');
  }
  if (entry.projectPath && projectMemoryMatches(entry, match)) {
    score += 16;
    reasons.push('project-match');
  }
  if (request.sessionId && entry.sessionId === request.sessionId) {
    score += 10;
    reasons.push('session-match');
  }
  if (entry.source.sourceOfTruth === 'light_file') {
    score += 8;
    reasons.push('light-source');
  }
  score += Math.max(0, Math.min(12, entry.confidence * 12));

  if (tokens.length > 0) {
    const title = normalizeText(entry.title);
    const summary = normalizeText(entry.summary);
    const content = normalizeText(entry.content);
    let matched = 0;
    for (const token of tokens) {
      if (title.includes(token)) {
        score += 12;
        matched++;
      } else if (summary.includes(token)) {
        score += 8;
        matched++;
      } else if (content.includes(token)) {
        score += 4;
        matched++;
      }
    }
    if (matched > 0) reasons.push(`query-match:${matched}`);
    else score -= 12;
  }

  return { score, reasons };
}
