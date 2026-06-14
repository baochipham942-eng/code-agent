// ============================================================================
// workspaceGrouping - Group sessions by project first, workspace as fallback.
// ============================================================================
// Sessions with a persisted projectId are bucketed by that Project. Sessions
// without project metadata fall back to full workingDirectory path so same-name
// folders under different parents stay separate. A separate uncategorized
// bucket collects sessions that have no project/workspace context.

import { UNSORTED_PROJECT_ID } from '@shared/contract/project';
import type { SessionWithMeta } from '../stores/sessionStore';

// Key used for sessions with no workingDirectory; reserved so it can't
// collide with an actual workspace path.
export const UNCATEGORIZED_WORKSPACE_KEY = '__chats__';

export interface WorkspaceGroup {
  /** Stable identifier. Project groups use project:<id>, workspace fallback
   *  groups use the full workspace path, and the fallback bucket uses
   *  UNCATEGORIZED_WORKSPACE_KEY. */
  key: string;
  /** Display name — project groups use their primary workspace basename until
   *  Project metadata loads; fallback bucket uses '未分类'. */
  name: string;
  /** Primary workspace path, usually the most recently active session's path. */
  path?: string;
  /** All workspace paths represented by the group, newest activity first. */
  paths: string[];
  /** Project id for this group, when known. */
  projectId?: string;
  /** true iff this is the bucket for sessions with no project/workspace. */
  isUncategorized: boolean;
  /** Sessions in this group, ordered most-recently-updated first. */
  sessions: SessionWithMeta[];
  /** Max updatedAt across sessions; drives group ordering. */
  latestActivityAt: number;
}

interface SidebarGroupKeySource {
  projectId?: string | null;
  workingDirectory?: string | null;
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return path;
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || trimmed;
}

interface SessionBucket {
  sessions: SessionWithMeta[];
  projectId?: string;
}

function projectGroupKey(projectId: string): string {
  return `project:${projectId}`;
}

function getSessionProjectId(session: SidebarGroupKeySource): string | undefined {
  const projectId = session.projectId?.trim();
  if (!projectId || projectId === UNSORTED_PROJECT_ID) {
    return undefined;
  }
  return projectId;
}

export function getSidebarGroupKeyForSession(session: SidebarGroupKeySource): string {
  const projectId = getSessionProjectId(session);
  if (projectId) {
    return projectGroupKey(projectId);
  }

  const path = session.workingDirectory?.trim();
  return path || UNCATEGORIZED_WORKSPACE_KEY;
}

function getGroupPaths(sessions: SessionWithMeta[]): string[] {
  const paths: string[] = [];
  for (const session of sessions) {
    const path = session.workingDirectory?.trim();
    if (path && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Partition sessions into project/workspace groups.
 *
 * - Project groups are keyed by persisted projectId.
 * - Sessions without project metadata fall back to full workingDirectory path.
 * - The uncategorized bucket (if non-empty) is always appended at the end.
 */
export function groupByWorkspace(sessions: SessionWithMeta[]): WorkspaceGroup[] {
  const buckets = new Map<string, SessionBucket>();

  for (const session of sessions) {
    const key = getSidebarGroupKeyForSession(session);
    const projectId = getSessionProjectId(session);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.sessions.push(session);
    } else {
      buckets.set(key, { sessions: [session], projectId });
    }
  }

  const categorized: WorkspaceGroup[] = [];
  let uncategorized: WorkspaceGroup | null = null;

  for (const [key, bucket] of buckets.entries()) {
    const sortedSessions = [...bucket.sessions].sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    );
    const latestActivityAt = sortedSessions.reduce(
      (max, s) => Math.max(max, s.updatedAt || 0),
      0,
    );
    const paths = getGroupPaths(sortedSessions);
    const primaryPath = paths[0];

    if (key === UNCATEGORIZED_WORKSPACE_KEY) {
      uncategorized = {
        key,
        name: '未分类',
        isUncategorized: true,
        paths,
        sessions: sortedSessions,
        latestActivityAt,
      };
    } else {
      categorized.push({
        key,
        name: primaryPath ? basenameOf(primaryPath) : 'Project',
        path: primaryPath,
        paths,
        isUncategorized: false,
        projectId: bucket.projectId,
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
