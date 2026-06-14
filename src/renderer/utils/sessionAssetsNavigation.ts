export interface SessionAssetsNavigation {
  targetSessionId: string;
  shouldSwitchSession: boolean;
  workspacePreviewItemId: string | null;
}

export interface SessionAssetsNavigationTarget {
  artifactId?: string | null;
  messageId?: string | null;
  path?: string | null;
  previewItemId?: string | null;
}

export function buildWorkspacePreviewArtifactItemId(
  target?: SessionAssetsNavigationTarget | null,
): string | null {
  const previewItemId = target?.previewItemId?.trim();
  if (previewItemId) {
    return previewItemId;
  }

  const artifactId = target?.artifactId?.trim();
  const messageId = target?.messageId?.trim();
  if (artifactId && messageId) {
    return `artifact:${messageId}:${artifactId}`;
  }

  const path = target?.path?.trim();
  return path ? `file:${path}` : null;
}

export function buildSessionAssetsNavigation(
  currentSessionId: string | null | undefined,
  targetSessionId: string,
  assetTarget?: SessionAssetsNavigationTarget | null,
): SessionAssetsNavigation | null {
  const normalizedSessionId = targetSessionId.trim();
  if (!normalizedSessionId) {
    return null;
  }

  return {
    targetSessionId: normalizedSessionId,
    shouldSwitchSession: normalizedSessionId !== currentSessionId,
    workspacePreviewItemId: buildWorkspacePreviewArtifactItemId(assetTarget),
  };
}
