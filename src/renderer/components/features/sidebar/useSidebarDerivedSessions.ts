import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AdminReviewQueueItem } from '@shared/contract/productClosure';
import type { BackgroundTaskInfo } from '@shared/contract/sessionState';
import type { CrossSessionSearchResults, SessionReviewItemsRequest } from '@shared/ipc/types';
import { useSessionStore, type SessionWithMeta } from '../../../stores/sessionStore';
import { useSessionUIStore } from '../../../stores/sessionUIStore';
import { useAppStore } from '../../../stores/appStore';
import { useBackgroundTaskStore } from '../../../stores/backgroundTaskStore';
import { useWorkflowStore } from '../../../stores/workflowStore';
import { useTaskStore } from '../../../stores/taskStore';
import ipcService from '../../../services/ipcService';
import { createLogger } from '../../../utils/logger';
import { groupByWorkspace } from '../../../utils/workspaceGrouping';
import { type SidebarProjectMeta } from '../../../utils/sidebarProjectSummary';
import {
  buildSessionSearchText,
  getSessionStatusPresentation,
  matchesSessionStatusFilter,
} from '../../../utils/sessionPresentation';
import { sortSidebarSessionsForRecovery } from '../../../utils/sidebarSessionOrdering';
import { hasSessionDeliverySignals } from '../../../utils/sessionRecoveryHints';
import {
  buildSidebarMessageSearchHitGroups,
  getCurrentProjectSearchSessionIds,
  resolveSidebarSearchScope,
  type SidebarMessageSearchHitGroup,
  type SidebarSearchScope,
} from '../../../utils/sidebarMessageSearch';
import { buildSessionReplayEvidenceMap } from '../../../utils/sessionReplayEvidence';
import { getProjectArtifacts, getProjectDetail } from '../../../services/projectClient';

const logger = createLogger('Sidebar');

const SIDEBAR_MESSAGE_SEARCH_DEBOUNCE_MS = 250;

export interface UseSidebarDerivedSessionsParams {
  canOpenSessionReplay: boolean;
}

export interface SidebarDerivedSessions {
  backgroundTaskMap: Map<string, BackgroundTaskInfo>;
  replayEvidenceBySessionId: ReturnType<typeof buildSessionReplayEvidenceMap>;
  hasPendingApprovalForSession: (sessionId: string) => boolean;
  currentProjectSearchSessionIds: Set<string>;
  effectiveSearchScope: SidebarSearchScope;
  searchScope: SidebarSearchScope;
  setSearchScope: (scope: SidebarSearchScope) => void;
  allowedSearchSessionIds: Set<string>;
  messageSearchHitsBySessionId: Record<string, SidebarMessageSearchHitGroup>;
  messageSearchLoading: boolean;
  reviewItemsBySessionId: Record<string, AdminReviewQueueItem[]>;
  filteredSessions: SessionWithMeta[];
  workspaceGroupedSessions: ReturnType<typeof groupByWorkspace>;
  visibleProjectIds: string[];
  visibleSessionIds: string[];
  projectMetaById: Record<string, SidebarProjectMeta>;
  setProjectMetaById: Dispatch<SetStateAction<Record<string, SidebarProjectMeta>>>;
}

/**
 * Sidebar 派生会话数据 hook：把会话分组、搜索范围、消息内容搜索、项目摘要、待审 issue
 * 等纯派生逻辑（8 个 memo + 3 个数据加载 effect + 其内部 state）从 `Sidebar` 巨型组件抽出。
 * 行为与原组件内联实现完全一致——hook 顶层无条件调用保证 hook 顺序，memo/effect 依赖原样保留。
 */
export function useSidebarDerivedSessions(
  params: UseSidebarDerivedSessionsParams,
): SidebarDerivedSessions {
  const { canOpenSessionReplay } = params;

  const sessions = useSessionStore((state) => state.sessions);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionRuntimes = useSessionStore((state) => state.sessionRuntimes);
  const backgroundTasks = useSessionStore((state) => state.backgroundTasks);
  const durableBackgroundTasks = useBackgroundTaskStore((state) => state.tasks);
  const workflowRuns = useWorkflowStore((state) => state.runs);
  const sessionStates = useTaskStore((state) => state.sessionStates);
  const searchQuery = useSessionUIStore((state) => state.searchQuery);
  const sessionStatusFilter = useSessionUIStore((state) => state.sessionStatusFilter);
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore((state) => state.pendingPermissionSessionId);
  const queuedPermissionRequests = useAppStore((state) => state.queuedPermissionRequests);

  const backgroundTaskMap = useMemo(
    () => new Map(backgroundTasks.map((task) => [task.sessionId, task])),
    [backgroundTasks],
  );

  const replayEvidenceBySessionId = useMemo(
    () => buildSessionReplayEvidenceMap(workflowRuns, durableBackgroundTasks),
    [durableBackgroundTasks, workflowRuns],
  );

  const hasPendingApprovalForSession = useCallback(
    (sessionId: string) => Boolean(
      (pendingPermissionRequest && pendingPermissionSessionId === sessionId) ||
      (queuedPermissionRequests?.[sessionId]?.length ?? 0) > 0
    ),
    [pendingPermissionRequest, pendingPermissionSessionId, queuedPermissionRequests],
  );

  const currentProjectSearchSessionIds = useMemo(
    () => getCurrentProjectSearchSessionIds(sessions, currentSessionId),
    [currentSessionId, sessions],
  );

  const [searchScope, setSearchScope] = useState<SidebarSearchScope>('current-project');
  const effectiveSearchScope = resolveSidebarSearchScope(searchScope, currentProjectSearchSessionIds);
  const allowedSearchSessionIds = useMemo(
    () => effectiveSearchScope === 'current-project'
      ? currentProjectSearchSessionIds
      : new Set(sessions.map((session) => session.id)),
    [currentProjectSearchSessionIds, effectiveSearchScope, sessions],
  );

  const [messageSearchHitsBySessionId, setMessageSearchHitsBySessionId] = useState<Record<string, SidebarMessageSearchHitGroup>>({});
  const [messageSearchLoading, setMessageSearchLoading] = useState(false);
  const [reviewItemsBySessionId, setReviewItemsBySessionId] = useState<Record<string, AdminReviewQueueItem[]>>({});

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setMessageSearchHitsBySessionId({});
      setMessageSearchLoading(false);
      return undefined;
    }

    const allowedSessionIds = allowedSearchSessionIds;
    const sessionIds = Array.from(allowedSessionIds);
    let cancelled = false;
    const timer = setTimeout(() => {
      setMessageSearchLoading(true);
      void ipcService.invoke(IPC_CHANNELS.SESSION_SEARCH, {
        query,
        options: { limit: 80, sessionIds },
      }).then((results) => {
        if (cancelled) return;
        const typedResults = results as CrossSessionSearchResults | null | undefined;
        setMessageSearchHitsBySessionId(buildSidebarMessageSearchHitGroups(
          typedResults?.results ?? [],
          allowedSessionIds,
        ));
      }).catch((error) => {
        if (cancelled) return;
        logger.warn('Sidebar message search failed', {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        setMessageSearchHitsBySessionId({});
      }).finally(() => {
        if (!cancelled) {
          setMessageSearchLoading(false);
        }
      });
    }, SIDEBAR_MESSAGE_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [allowedSearchSessionIds, searchQuery]);

  // Apply local metadata search, message-content hits, and session-native status filter.
  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sessions.filter((session) => {
      const status = getSessionStatusPresentation({
        backgroundTask: backgroundTaskMap.get(session.id),
        runtime: sessionRuntimes.get(session.id),
        taskState: sessionStates[session.id],
        messageCount: session.messageCount,
        turnCount: session.turnCount,
        sessionStatus: session.status,
        hasPendingApproval: hasPendingApprovalForSession(session.id),
      });
      const hasPendingReview = (reviewItemsBySessionId[session.id] ?? [])
        .some((item) => item.reviewStatus === 'pending');
      if (!matchesSessionStatusFilter(sessionStatusFilter, status.kind, {
        hasDeliverySignals: hasSessionDeliverySignals(session, {
          hasReplay: replayEvidenceBySessionId.has(session.id),
        }),
        hasPendingReview,
      })) {
        return false;
      }

      if (!q) {
        return true;
      }

      if (!allowedSearchSessionIds.has(session.id)) {
        return false;
      }

      if (messageSearchHitsBySessionId[session.id]) {
        return true;
      }

      return buildSessionSearchText({
        session,
        snapshot: session.workbenchSnapshot,
        status,
      }).includes(q);
    });
  }, [
    backgroundTaskMap,
    hasPendingApprovalForSession,
    allowedSearchSessionIds,
    messageSearchHitsBySessionId,
    replayEvidenceBySessionId,
    reviewItemsBySessionId,
    searchQuery,
    sessionRuntimes,
    sessionStatusFilter,
    sessions,
    sessionStates,
  ]);

  // Pure workspace grouping (Codex-style): one bucket per workingDirectory,
  // sorted by latest activity; sessions without a workingDirectory go into a
  // trailing uncategorized bucket. No time sub-groups inside workspaces.
  const workspaceGroupedSessions = useMemo(
    () => groupByWorkspace(filteredSessions).map((group) => ({
      ...group,
      sessions: sortSidebarSessionsForRecovery(
        group.sessions,
        (session) => getSessionStatusPresentation({
          backgroundTask: backgroundTaskMap.get(session.id),
          runtime: sessionRuntimes.get(session.id),
          taskState: sessionStates[session.id],
          messageCount: session.messageCount,
          turnCount: session.turnCount,
          sessionStatus: session.status,
          hasPendingApproval: hasPendingApprovalForSession(session.id),
        }).kind,
        (session) => Math.max(
          session.updatedAt || 0,
          sessionRuntimes.get(session.id)?.lastActivityAt || 0,
          backgroundTaskMap.get(session.id)?.backgroundedAt || 0,
        ),
      ),
    })),
    [backgroundTaskMap, filteredSessions, hasPendingApprovalForSession, sessionRuntimes, sessionStates],
  );
  const visibleProjectIds = useMemo(
    () => Array.from(new Set(
      workspaceGroupedSessions
        .filter((group) => !group.isUncategorized)
        .map((group) => group.projectId?.trim())
        .filter((projectId): projectId is string => Boolean(projectId)),
    )).sort(),
    [workspaceGroupedSessions],
  );
  const [projectMetaById, setProjectMetaById] = useState<Record<string, SidebarProjectMeta>>({});
  const visibleSessionIds = useMemo(
    () => workspaceGroupedSessions.flatMap((group) => group.sessions.map((session) => session.id)),
    [workspaceGroupedSessions],
  );
  const visibleSessionIdsKey = visibleSessionIds.join('\n');

  useEffect(() => {
    if (visibleProjectIds.length === 0) {
      setProjectMetaById({});
      return undefined;
    }

    let cancelled = false;
    void Promise.all(visibleProjectIds.map(async (projectId): Promise<[string, SidebarProjectMeta] | null> => {
      try {
        const [detail, artifacts] = await Promise.all([
          getProjectDetail(projectId),
          getProjectArtifacts(projectId),
        ]);
        const visibleGoals = detail.goals.filter((goal) => goal.status !== 'archived');
        const activeGoals = visibleGoals.filter((goal) => goal.status === 'active');
        const sortedGoals = [...visibleGoals].sort((left, right) => {
          const statusRank = (status: typeof left.status) => status === 'active' ? 0 : status === 'aborted' ? 1 : 2;
          const rankDiff = statusRank(left.status) - statusRank(right.status);
          if (rankDiff !== 0) return rankDiff;
          return (right.updatedAt || 0) - (left.updatedAt || 0);
        });
        return [projectId, {
          name: detail.project.name,
          status: detail.project.status,
          description: detail.project.description,
          goalCount: visibleGoals.length,
          activeGoalTitles: activeGoals.map((goal) => goal.goal),
          goals: sortedGoals.slice(0, 5).map((goal) => ({
            id: goal.id,
            title: goal.goal,
            verify: goal.verify,
            review: goal.review,
            status: goal.status,
            updatedAt: goal.updatedAt,
            lastRunSessionId: goal.lastRunSessionId,
          })),
          roleCount: detail.roles.length,
          roleIds: detail.roles.map((role) => role.roleId),
          artifactCount: artifacts.length,
          recentArtifactTitles: artifacts.map((artifact) => artifact.title || artifact.kind),
          recentArtifacts: artifacts.slice(0, 5).map((artifact) => ({
            id: artifact.id,
            sessionId: artifact.sessionId,
            messageId: artifact.messageId,
            title: artifact.title || artifact.kind,
            kind: artifact.kind,
            sessionTitle: artifact.sessionTitle,
            createdAt: artifact.createdAt,
            path: artifact.path,
            url: artifact.url,
            toolCallId: artifact.toolCallId,
            toolName: artifact.toolName,
            previewItemId: artifact.previewItemId,
          })),
          sessionCount: detail.sessionIds.length,
          updatedAt: detail.project.updatedAt,
        }];
      } catch (error) {
        logger.warn('Failed to load sidebar project summary', {
          projectId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })).then((entries) => {
      if (cancelled) return;
      setProjectMetaById(Object.fromEntries(entries.filter((entry): entry is [string, SidebarProjectMeta] => entry !== null)));
    });

    return () => {
      cancelled = true;
    };
  }, [visibleProjectIds]);

  useEffect(() => {
    if (!canOpenSessionReplay || visibleSessionIds.length === 0) {
      setReviewItemsBySessionId({});
      return undefined;
    }

    let cancelled = false;
    const request: SessionReviewItemsRequest = {
      sessionIds: visibleSessionIds,
      limitPerSession: 3,
    };
    void ipcService.invoke(IPC_CHANNELS.SESSION_LIST_REVIEW_ITEMS, request)
      .then((itemsBySessionId) => {
        if (cancelled) return;
        setReviewItemsBySessionId(itemsBySessionId ?? {});
      })
      .catch((error) => {
        if (cancelled) return;
        logger.warn('Failed to load sidebar review items', {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        setReviewItemsBySessionId({});
      });

    return () => {
      cancelled = true;
    };
  }, [canOpenSessionReplay, visibleSessionIdsKey]);

  return {
    backgroundTaskMap,
    replayEvidenceBySessionId,
    hasPendingApprovalForSession,
    currentProjectSearchSessionIds,
    effectiveSearchScope,
    searchScope,
    setSearchScope,
    allowedSearchSessionIds,
    messageSearchHitsBySessionId,
    messageSearchLoading,
    reviewItemsBySessionId,
    filteredSessions,
    workspaceGroupedSessions,
    visibleProjectIds,
    visibleSessionIds,
    projectMetaById,
    setProjectMetaById,
  };
}
