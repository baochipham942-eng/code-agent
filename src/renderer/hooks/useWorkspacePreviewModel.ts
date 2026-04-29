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
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionDesignBriefs = useSessionStore((state) => state.sessionDesignBriefs);
  const lockedBrief = currentSessionId ? sessionDesignBriefs.get(currentSessionId) : undefined;

  return useMemo(() => {
    const items = buildWorkspacePreviewItems({
      messages,
      workingDirectory,
      pendingPermissionRequest,
      currentTurnArtifacts: currentTurnArtifacts
        ? {
            turnNumber: currentTurnArtifacts.turnNumber,
            artifactOwnership: currentTurnArtifacts.artifactOwnership,
          }
        : null,
    });
    if (!lockedBrief) return items;
    // 当前会话已锁定 brief 时，把它复制到所有非 question_form artifact 的 designBrief 上，
    // 让 PreviewListItem 标签复用 formatDesignBriefLabel 渲染 "premium · landing_page"。
    return items.map((item) =>
      item.kind === 'question_form' || item.designBrief
        ? item
        : { ...item, designBrief: lockedBrief },
    );
  }, [currentTurnArtifacts, messages, pendingPermissionRequest, workingDirectory, lockedBrief]);
}
