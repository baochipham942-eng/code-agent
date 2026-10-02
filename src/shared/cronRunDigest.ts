import type { SessionOriginKind } from './contract/session';

const CRON_SUMMARY_BLOCK_PATTERN = /<cron_summary\s*>([\s\S]*?)<\/cron_summary\s*>/i;

/** The tag pattern is shared by the parser and push-body sanitizer. */
export const CRON_SUMMARY_TAG_PATTERN = CRON_SUMMARY_BLOCK_PATTERN;

export interface CronRunDigest {
  summary?: string;
  artifacts: string[];
}

interface CronRunGroup<T> {
  taskId: string;
  runs: T[];
  runCount: number;
  latestSessionId: string;
}

export interface CronRunGroups<T> {
  groups: Record<string, CronRunGroup<T>>;
  ungrouped: T[];
}

/**
 * Parse the first complete cron delivery digest. Malformed input is an empty
 * digest so an agent reply can never make cron execution persistence fail.
 */
export function parseCronRunDigest(text: unknown): CronRunDigest {
  if (typeof text !== 'string') return { artifacts: [] };

  try {
    const match = text.match(CRON_SUMMARY_BLOCK_PATTERN);
    if (!match) return { artifacts: [] };

    const artifacts: string[] = [];
    const summaryLines: string[] = [];
    for (const line of match[1].split(/\r?\n/)) {
      const artifactMatch = line.match(/^\s*artifact:\s*(\S.*)?\s*$/i);
      if (artifactMatch) {
        const artifact = artifactMatch[1]?.trim();
        if (artifact && artifacts.length < 10) artifacts.push(artifact);
        continue;
      }
      summaryLines.push(line);
    }

    const summary = summaryLines.join('\n').trim().slice(0, 1000).trimEnd();
    return {
      ...(summary ? { summary } : {}),
      artifacts,
    };
  } catch {
    return { artifacts: [] };
  }
}

export type CronRunGroupable = {
  id: string;
  updatedAt: number;
  origin?: {
    kind: SessionOriginKind | string;
    id?: string;
  };
};

function taskOriginId(origin: CronRunGroupable['origin']): string | undefined {
  if (!origin || (origin.kind !== 'cron' && origin.kind !== 'heartbeat')) return undefined;
  const taskId = origin.id?.trim();
  return taskId || undefined;
}

/** Group cron/heartbeat sessions by their task origin while preserving other sessions. */
export function groupRunsByTask<T extends CronRunGroupable>(sessions: readonly T[]): CronRunGroups<T> {
  const grouped = new Map<string, Array<{ session: T; index: number }>>();
  const ungrouped: T[] = [];

  sessions.forEach((session, index) => {
    const taskId = taskOriginId(session.origin);
    if (!taskId) {
      ungrouped.push(session);
      return;
    }
    const runs = grouped.get(taskId) ?? [];
    runs.push({ session, index });
    grouped.set(taskId, runs);
  });

  const groups: Record<string, CronRunGroup<T>> = {};
  for (const [taskId, entries] of grouped) {
    entries.sort((a, b) => b.session.updatedAt - a.session.updatedAt || a.index - b.index);
    const runs = entries.map(({ session }) => session);
    groups[taskId] = {
      taskId,
      runs,
      runCount: runs.length,
      latestSessionId: runs[0].id,
    };
  }

  return { groups, ungrouped };
}

function reviewSessionId(record: {
  resultSessionId?: string | null;
  config?: { pendingReview?: { resultSessionId?: string | null } | null } | null;
}): string | undefined {
  for (const candidate of [record.resultSessionId, record.config?.pendingReview?.resultSessionId]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Count review records by cron/heartbeat task. Records that share a task origin
 * collapse to one. A record with no such session still counts, so an unlinked
 * review is not dropped.
 */
export function countPendingReviewByTask(
  records: readonly {
    resultSessionId?: string | null;
    config?: { pendingReview?: { resultSessionId?: string | null } | null } | null;
  }[],
  sessionsById: Readonly<Record<string, { origin?: CronRunGroupable['origin'] } | undefined>>,
): number {
  const seen = new Set<string>();
  let count = 0;
  for (const record of records) {
    const sessionId = reviewSessionId(record);
    const taskId = sessionId ? taskOriginId(sessionsById[sessionId]?.origin) : undefined;
    if (!taskId) {
      count += 1;
      continue;
    }
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    count += 1;
  }
  return count;
}
