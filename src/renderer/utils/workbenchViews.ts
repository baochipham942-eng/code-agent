// ============================================================================
// Workbench view registry
// The visible right rail has five view categories. Retired tab ids remain valid
// deep-link inputs and are resolved here so callers do not own IA routing.
// ============================================================================

export type PreviewWorkbenchViewId = `preview:${string}`;

export type WorkbenchViewId =
  | 'overview'
  | 'files'
  | 'browser'
  | 'design-canvas'
  | PreviewWorkbenchViewId;

type LegacyWorkbenchTabId =
  | 'task'
  | 'skills'
  | 'workspace-preview'
  | 'context'
  | 'audit'
  | 'project-collab';

export type WorkbenchTabId = WorkbenchViewId | LegacyWorkbenchTabId;

export type WorkbenchDeepLinkTarget =
  | { kind: 'workbench'; view: WorkbenchViewId }
  | { kind: 'capabilityHub'; tab: 'skills' }
  | { kind: 'contextHealth' }
  | { kind: 'sessionReplay' }
  | { kind: 'projectCollaboration' };

export const OPEN_CONTEXT_HEALTH_EVENT = 'app:openContextHealth';
export const OPEN_SESSION_REPLAY_EVENT = 'app:openSessionReplay';

export function resolveWorkbenchDeepLink(id: WorkbenchTabId): WorkbenchDeepLinkTarget {
  if (id === 'task' || id === 'workspace-preview') {
    return { kind: 'workbench', view: 'overview' };
  }
  if (id === 'skills') {
    return { kind: 'capabilityHub', tab: 'skills' };
  }
  if (id === 'context') {
    return { kind: 'contextHealth' };
  }
  if (id === 'audit') {
    return { kind: 'sessionReplay' };
  }
  if (id === 'project-collab') {
    return { kind: 'projectCollaboration' };
  }
  return { kind: 'workbench', view: id };
}

export function isPreviewWorkbenchView(
  id: WorkbenchViewId | null | undefined,
): id is PreviewWorkbenchViewId {
  return id?.startsWith('preview:') ?? false;
}
