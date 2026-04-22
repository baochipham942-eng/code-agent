// ============================================================================
// workspaceGrouping - Group sessions by their workingDirectory (workspace).
// ============================================================================
// Sessions are bucketed by full path so different workspaces with the same
// basename (e.g. two ".../projects/foo" under different parents) stay separate.
// A separate "Chats" bucket collects sessions that have no workingDirectory.

import type { SessionWithMeta } from '../stores/sessionStore';

// Key used for sessions with no workingDirectory; reserved so it can't
// collide with an actual workspace path.
export const UNCATEGORIZED_WORKSPACE_KEY = '__chats__';

export interface WorkspaceGroup {
  /** Stable identifier. For categorized groups this is the full workspace path;
   *  for the fallback bucket this is UNCATEGORIZED_WORKSPACE_KEY. */
  key: string;
  /** Display name — basename of the path, or 'Chats' for the fallback. */
  name: string;
  /** Full path (undefined for the uncategorized bucket). */
  path?: string;
  /** true iff this is the Chats bucket for sessions with no workingDirectory. */
  isUncategorized: boolean;
  /** Sessions in this workspace, ordered most-recently-updated first. */
  sessions: SessionWithMeta[];
  /** Max updatedAt across sessions; drives workspace ordering. */
  latestActivityAt: number;
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return path;
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || trimmed;
}

/**
 * Partition sessions into workspace groups.
 *
 * - Categorized groups (sessions with a workingDirectory) are sorted by
 *   their latest activity, most recent first.
 * - The "Chats" bucket (if non-empty) is always appended at the end.
 */
export function groupByWorkspace(sessions: SessionWithMeta[]): WorkspaceGroup[] {
  const buckets = new Map<string, SessionWithMeta[]>();

  for (const session of sessions) {
    const path = session.workingDirectory?.trim();
    const key = path ? path : UNCATEGORIZED_WORKSPACE_KEY;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(session);
    } else {
      buckets.set(key, [session]);
    }
  }

  const categorized: WorkspaceGroup[] = [];
  let uncategorized: WorkspaceGroup | null = null;

  for (const [key, groupSessions] of buckets.entries()) {
    const sortedSessions = [...groupSessions].sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    );
    const latestActivityAt = sortedSessions.reduce(
      (max, s) => Math.max(max, s.updatedAt || 0),
      0,
    );

    if (key === UNCATEGORIZED_WORKSPACE_KEY) {
      uncategorized = {
        key,
        name: 'Chats',
        isUncategorized: true,
        sessions: sortedSessions,
        latestActivityAt,
      };
    } else {
      categorized.push({
        key,
        name: basenameOf(key),
        path: key,
        isUncategorized: false,
        sessions: sortedSessions,
        latestActivityAt,
      });
    }
  }

  categorized.sort((a, b) => b.latestActivityAt - a.latestActivityAt);

  return uncategorized ? [...categorized, uncategorized] : categorized;
}

/**
 * A workspace is expanded by default. Only an explicit `false` collapses it,
 * so entries not yet recorded in the persisted map still open on first sight.
 */
export function isWorkspaceExpanded(
  expandedMap: Record<string, boolean>,
  key: string,
): boolean {
  return expandedMap[key] !== false;
}
