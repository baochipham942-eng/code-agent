import { useEffect, useMemo, useState } from 'react';
import type { ArtifactIssue, WorkspacePreviewItem, WorkspacePreviewQuality } from '@shared/contract';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useCurrentTurnArtifactOwnership } from './useCurrentTurnArtifactOwnership';
import { buildWorkspacePreviewItems } from '../utils/workspacePreview';
import { getArtifactIssuesByArtifactId } from '../services/projectClient';

const ACTIVE_ISSUE_STATUSES = new Set(['open', 'accepted', 'in_progress']);

function severityRank(severity: ArtifactIssue['severity']): number {
  switch (severity) {
    case 'critical':
      return 5;
    case 'high':
      return 4;
    case 'medium':
      return 3;
    case 'low':
      return 2;
    default:
      return 1;
  }
}

function qualityFromRepositoryIssues(issues: ArtifactIssue[] | undefined): WorkspacePreviewQuality | undefined {
  if (!issues?.length) return undefined;
  const active = issues.filter((issue) => ACTIVE_ISSUE_STATUSES.has(issue.status));
  if (active.length === 0) {
    return {
      status: 'passed',
      summary: 'Tracked artifact issues are resolved',
      issueCount: issues.length,
    };
  }
  const blocking = active.some((issue) => severityRank(issue.severity) >= 4);
  const first = active.slice().sort((left, right) => severityRank(right.severity) - severityRank(left.severity))[0];
  return {
    status: blocking ? 'failed' : 'needs_review',
    summary: first?.title || `${active.length} active artifact issue(s)`,
    issueCount: active.length,
    blocking,
  };
}

function artifactIssueLookupId(item: WorkspacePreviewItem): string | undefined {
  return item.revision?.artifactId;
}

function mergeRepositoryIssueQuality(
  items: WorkspacePreviewItem[],
  issueMap: Record<string, ArtifactIssue[]>,
): WorkspacePreviewItem[] {
  return items.map((item) => {
    const artifactId = artifactIssueLookupId(item);
    if (!artifactId) return item;
    const issueQuality = qualityFromRepositoryIssues(issueMap[artifactId]);
    if (!issueQuality) return item;
    if (!item.quality || issueQuality.status === 'failed' || issueQuality.status === 'needs_review') {
      return { ...item, quality: issueQuality };
    }
    return item;
  });
}

export function useWorkspacePreviewModel() {
  const messages = useSessionStore((state) => state.messages);
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const currentTurnArtifacts = useCurrentTurnArtifactOwnership();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionDesignBriefs = useSessionStore((state) => state.sessionDesignBriefs);
  const lockedBrief = currentSessionId ? sessionDesignBriefs.get(currentSessionId) : undefined;
  const [artifactIssues, setArtifactIssues] = useState<Record<string, ArtifactIssue[]>>({});

  const baseItems = useMemo(() => (
    buildWorkspacePreviewItems({
      messages,
      workingDirectory,
      pendingPermissionRequest,
      currentTurnArtifacts: currentTurnArtifacts
        ? {
            turnNumber: currentTurnArtifacts.turnNumber,
            artifactOwnership: currentTurnArtifacts.artifactOwnership,
          }
        : null,
    })
  ), [currentTurnArtifacts, messages, pendingPermissionRequest, workingDirectory]);

  const artifactIds = useMemo(() => (
    Array.from(new Set(baseItems.map(artifactIssueLookupId).filter((id): id is string => Boolean(id))))
  ), [baseItems]);

  useEffect(() => {
    if (artifactIds.length === 0) {
      setArtifactIssues({});
      return;
    }
    let cancelled = false;
    void getArtifactIssuesByArtifactId(artifactIds, { limit: 20 })
      .then((issues) => {
        if (!cancelled) setArtifactIssues(issues);
      })
      .catch(() => {
        if (!cancelled) setArtifactIssues({});
      });
    return () => {
      cancelled = true;
    };
  }, [artifactIds]);

  return useMemo(() => {
    const items = mergeRepositoryIssueQuality(baseItems, artifactIssues);
    if (!lockedBrief) return items;
    // 当前会话已锁定 brief 时，把它复制到所有非 question_form artifact 的 designBrief 上，
    // 让 PreviewListItem 标签复用 formatDesignBriefLabel 渲染 "premium · landing_page"。
    return items.map((item) =>
      item.kind === 'question_form' || item.designBrief
        ? item
        : { ...item, designBrief: lockedBrief },
    );
  }, [artifactIssues, baseItems, lockedBrief]);
}
