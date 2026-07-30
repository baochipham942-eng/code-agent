import { useEffect, useMemo, useState } from 'react';
import type { ArtifactIssue, WorkspacePreviewItem, WorkspacePreviewQuality } from '@shared/contract';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useCurrentTurnArtifactOwnership } from './useCurrentTurnArtifactOwnership';
import type { CurrentTurnArtifactOwnershipView } from './useCurrentTurnArtifactOwnership';
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

export interface WorkspacePreviewModelState {
  items: WorkspacePreviewItem[];
  currentTurnArtifacts: CurrentTurnArtifactOwnershipView | null;
}

/** artifact id 里不会出现 NUL，拿它拼内容键不会和 id 本身冲突。 */
const ARTIFACT_ID_SEPARATOR = '\u0000';
const EMPTY_ARTIFACT_IDS: string[] = [];

export function useWorkspacePreviewModelState(): WorkspacePreviewModelState {
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

  // 必须按「id 集合的内容」稳定，不能按 baseItems 的身份稳定。
  // baseItems 的上游（currentTurnArtifacts ← 当前轮投影）每渲染都换身份，所以直接
  // memo 在 baseItems 上时，artifactIds 每渲染都是新数组 → 下面那条 effect 每渲染
  // 重跑 → `setArtifactIssues({})` 每渲染塞一个新对象（新引用，React 无法 bail out）
  // → 立刻又触发渲染，形成满速自激循环。实测 App 被拖到 235 次/秒重渲染，最终把
  // React 的 50 层嵌套更新上限打满抛 #185，整个 app 被 App 级 ErrorBoundary 罩死。
  // 顺带：重跑还意味着每渲染打一次 getArtifactIssuesByArtifactId，等于对 host 的请求风暴。
  const artifactIdsKey = useMemo(() => (
    Array.from(new Set(baseItems.map(artifactIssueLookupId).filter((id): id is string => Boolean(id))))
      .join(ARTIFACT_ID_SEPARATOR)
  ), [baseItems]);
  const artifactIds = useMemo(
    () => (artifactIdsKey === '' ? EMPTY_ARTIFACT_IDS : artifactIdsKey.split(ARTIFACT_ID_SEPARATOR)),
    [artifactIdsKey],
  );

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

  const items = useMemo(() => {
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

  return useMemo(
    () => ({ items, currentTurnArtifacts }),
    [currentTurnArtifacts, items],
  );
}

export function useWorkspacePreviewModel(): WorkspacePreviewItem[] {
  return useWorkspacePreviewModelState().items;
}
