import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import {
  deriveSurfaceIntentTurnId,
  type SurfaceArtifact,
  type SurfaceIntentDecision,
} from '../utils/surfaceIntent';
import { requestSurfaceIntent } from './surfaceIntentRuntime';

export function openSurfaceForArtifact(input: {
  artifact: SurfaceArtifact;
  artifactSessionId?: string;
}): SurfaceIntentDecision | null {
  const sessionState = useSessionStore.getState();
  const currentSessionId = sessionState.currentSessionId;
  const decision = requestSurfaceIntent({
    artifact: input.artifact,
    artifactSessionId: input.artifactSessionId,
    currentSessionId,
    turnId: deriveSurfaceIntentTurnId(sessionState.messages),
  });
  if (!decision) return null;

  const appState = useAppStore.getState();
  switch (decision.view) {
    case 'workspace-preview':
      appState.openWorkspacePreview(decision.itemId, { source: 'auto' });
      break;
    case 'file-preview':
      appState.openPreview(decision.filePath, { source: 'auto' });
      break;
    case 'design-canvas':
      appState.openWorkbenchTab('design-canvas', { source: 'auto' });
      break;
    case 'task-monitor':
      appState.openWorkbenchTab('task', { source: 'auto' });
      appState.setTaskPanelTab('monitor');
      break;
  }
  return decision;
}
