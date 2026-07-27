import type { Session } from '../../../../shared/contract/session';
import type { WorkspaceScope } from '../../../../shared/contract/project';

export interface SessionForkWorkspaceScopeReader {
  getSessionForkWorkspaceScope?(
    sessionId: string,
    ownerUserId?: string | null,
  ): WorkspaceScope | null;
}

export interface ProjectWorkspaceScopeReader {
  getWorkspaceScope(projectId: string): WorkspaceScope | undefined;
}

/**
 * One workspace-boundary resolver for Native and every external engine.
 *
 * An isolated Fork must use its verified durable worktree as the only runtime
 * root. The source Project scope remains provenance and must never be used as
 * an execution fallback for that child.
 */
export function resolveSessionWorkspaceScope(
  session: Pick<Session, 'id' | 'projectId' | 'metadata'> | null | undefined,
  ownerUserId: string | null,
  database: SessionForkWorkspaceScopeReader,
  projects: ProjectWorkspaceScopeReader,
): WorkspaceScope | undefined {
  if (!session) return undefined;
  const metadata = session.metadata as Record<string, unknown> | undefined;
  const lineage = metadata?.forkLineage;
  const lineageWorkspaceMode = lineage && typeof lineage === 'object' && !Array.isArray(lineage)
    ? (lineage as Record<string, unknown>).workspaceMode
    : undefined;
  const expectsIsolated = metadata?.forkWorkspaceScopeV1 !== undefined
    || lineageWorkspaceMode === 'isolated_at_anchor';
  if (!database.getSessionForkWorkspaceScope) {
    if (expectsIsolated) {
      throw new Error('Verified isolated WorkspaceScope resolver is unavailable');
    }
    return session.projectId
      ? projects.getWorkspaceScope(session.projectId)
      : undefined;
  }

  let isolatedScope: WorkspaceScope | null = null;
  try {
    isolatedScope = database.getSessionForkWorkspaceScope(
      session.id,
      ownerUserId,
    );
  } catch (error) {
    if (expectsIsolated) throw error;
    // Keep existing non-Fork sessions functional when the optional Fork
    // repository is unavailable during early startup or in legacy hosts.
  }
  if (isolatedScope) return isolatedScope;
  if (expectsIsolated) {
    throw new Error('Isolated Fork has no verified durable WorkspaceScope');
  }
  return session.projectId
    ? projects.getWorkspaceScope(session.projectId)
    : undefined;
}
