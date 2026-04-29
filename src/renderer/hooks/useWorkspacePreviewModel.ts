import { useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useCurrentTurnArtifactOwnership } from './useCurrentTurnArtifactOwnership';
import { buildWorkspacePreviewItems } from '../utils/workspacePreview';

export function useWorkspacePreviewModel() {
  const messages = useSessionStore((state) => state.messages);
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const currentTurnArtifacts = useCurrentTurnArtifactOwnership();

  return useMemo(() => buildWorkspacePreviewItems({
    messages,
    workingDirectory,
    pendingPermissionRequest,
    currentTurnArtifacts: currentTurnArtifacts
      ? {
          turnNumber: currentTurnArtifacts.turnNumber,
          artifactOwnership: currentTurnArtifacts.artifactOwnership,
        }
      : null,
  }), [currentTurnArtifacts, messages, pendingPermissionRequest, workingDirectory]);
}
