import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AgentTrajectorySessionQualitySummary } from '@shared/contract/agentTrajectory';
import type { AdminReviewQueueItem } from '@shared/contract/productClosure';
import type { BackgroundSessionInfo } from '@shared/contract/sessionState';
import type { CrossSessionSearchResults, SessionReviewItemsRequest } from '@shared/ipc/types';
import { useSessionStore, type SessionWithMeta } from '../../../stores/sessionStore';
import { useSessionUIStore, type TrajectoryReviewFilter } from '../../../stores/sessionUIStore';
import { useAppStore } from '../../../stores/appStore';
import { useBackgroundTaskStore } from '../../../stores/backgroundTaskStore';
import { useWorkflowStore } from '../../../stores/workflowStore';
import { useTaskStore } from '../../../stores/taskStore';
import ipcService from '../../../services/ipcService';
import { createLogger } from '../../../utils/logger';
import { groupByWorkspace } from '../../../utils/workspaceGrouping';
import { DESIGN_WORKSPACE } from '@shared/constants';
import { type SidebarProjectMeta } from '../../../utils/sidebarProjectSummary';
import {
  buildSessionSearchText,
  getSessionStatusPresentation,
  matchesSessionStatusFilter,
} from '../../../utils/sessionPresentation';
import { hasNeedsInputForSession as deriveHasNeedsInputForSession } from '../../../utils/sessionNeedsInput';
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
const TRAJECTORY_QUALITY_SIDEBAR_LIMIT = 250;

export function matchesTrajectoryReviewFilter(
  summary: AgentTrajectorySessionQualitySummary | undefined,
  filter: TrajectoryReviewFilter,
): boolean {
  if (filter === 'all') return true;
  if (!summary) return false;
  const reviewed = summary.collection.source === 'manual_review';
  return filter === 'reviewed' ? reviewed : !reviewed;
}

export interface UseSidebarDerivedSessionsParams {
  canOpenSessionReplay: boolean;
}

export interface SidebarDerivedSessions {
  backgroundSessionMap: Map<string, BackgroundSessionInfo>;
  replayEvidenceBySessionId: ReturnType<typeof buildSessionReplayEvidenceMap>;
  hasNeedsInputForSession: (sessionId: string) => boolean;
  hasPendingApprovalForSession: (sessionId: string) => boolean;
  currentProjectSearchSessionIds: Set<string>;
  effectiveSearchScope: SidebarSearchScope;
  searchScope: SidebarSearchScope;
  setSearchScope: (scope: SidebarSearchScope) => void;
  allowedSearchSessionIds: Set<string>;
  messageSearchHitsBySessionId: Record<string, SidebarMessageSearchHitGroup>;
  messageSearchLoading: boolean;
  searchResultSessions: SessionWithMeta[];
  reviewItemsBySessionId: Record<string, AdminReviewQueueItem[]>;
  trajectoryQualityBySessionId: Record<string, AgentTrajectorySessionQualitySummary>;
  mergeTrajectoryQualitySummary: (sessionId: string, summary: AgentTrajectorySessionQualitySummary) => void;
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
export function useSidebarDerivedSessions(params: UseSidebarDerivedSessionsParams): SidebarDerivedSessions {
  const { canOpenSessionReplay } = params;

  const sessions = useSessionStore((state) => state.sessions);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionRuntimes = useSessionStore((state) => state.sessionRuntimes);
  const backgroundSessions = useSessionStore((state) => state.backgroundSessions);
  const pendingUserQuestionsBySessionId = useSessionStore((state) => state.pendingUserQuestionsBySessionId);
  const durableBackgroundTasks = useBackgroundTaskStore((state) => state.tasks);
  const workflowRuns = useWorkflowStore((state) => state.runs);
  const sessionStates = useTaskStore((state) => state.sessionStates);
  const searchQuery = useSessionUIStore((state) => state.searchQuery);
  const sessionStatusFilter = useSessionUIStore((state) => state.sessionStatusFilter);
  const trajectoryTierFilter = useSessionUIStore((state) => state.trajectoryTierFilter);
  const trajectoryFailureFilter = useSessionUIStore((state) => state.trajectoryFailureFilter);
  const trajectoryReviewFilter = useSessionUIStore((state) => state.trajectoryReviewFilter);
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore((state) => state.pendingPermissionSessionId);
  const queuedPermissionRequests = useAppStore((state) => state.queuedPermissionRequests);

  const backgroundSessionMap = useMemo(
    () => new Map(backgroundSessions.map((session) => [session.sessionId, session])),
    [backgroundSessions],
  );

  const replayEvidenceBySessionId = useMemo(
    () => buildSessionReplayEvidenceMap(workflowRuns, durableBackgroundTasks),
    [durableBackgroundTasks, workflowRuns],
  );

  const durableWaitingApprovalSessionIds = useMemo(
    () => new Set(sessions.filter((session) => session.durableWaitingInput === true).map((session) => session.id)),
    [sessions],
  );

  const hasNeedsInputForSession = useCallback(
    (sessionId: string) =>
      deriveHasNeedsInputForSession(sessionId, {
        permissionState: {
          pendingPermissionRequest,
          pendingPermissionSessionId,
          queuedPermissionRequests,
        },
        backgroundTasks: durableBackgroundTasks,
        pendingUserQuestionsBySessionId,
        durableWaitingApprovalSessionIds,
      }),
    [
      durableWaitingApprovalSessionIds,
      durableBackgroundTasks,
      pendingPermissionRequest,
      pendingPermissionSessionId,
      pendingUserQuestionsBySessionId,
      queuedPermissionRequests,
    ],
  );
  const hasPendingApprovalForSession = hasNeedsInputForSession;

  const currentProjectSearchSessionIds = useMemo(
    () => getCurrentProjectSearchSessionIds(sessions, currentSessionId),
    [currentSessionId, sessions],
  );

  // 默认全局：搜索从常驻输入框改成放大镜弹窗后，它是一个「全局搜索入口」——
  // 默认只搜当前项目会让人以为搜不到（正文命中的会话若在别的项目下就不出现）。
  // 想收窄仍可在弹窗里点「本项目」。
  const [searchScope, setSearchScope] = useState<SidebarSearchScope>('all');
  const effectiveSearchScope = resolveSidebarSearchScope(searchScope, currentProjectSearchSessionIds);
  const searchableSessions = useMemo(
    () => sessions.filter((session) => session.status !== 'archived'),
    [sessions],
  );
  const allowedSearchSessionIds = useMemo(
    () =>
      effectiveSearchScope === 'current-project'
        ? new Set(
            searchableSessions
              .filter((session) => currentProjectSearchSessionIds.has(session.id))
              .map((session) => session.id),
          )
        : new Set(searchableSessions.map((session) => session.id)),
    [currentProjectSearchSessionIds, effectiveSearchScope, searchableSessions],
  );

  const [messageSearchHitsBySessionId, setMessageSearchHitsBySessionId] = useState<
    Record<string, SidebarMessageSearchHitGroup>
  >({});
  const [messageSearchLoading, setMessageSearchLoading] = useState(false);
  const [reviewItemsBySessionId, setReviewItemsBySessionId] = useState<Record<string, AdminReviewQueueItem[]>>({});
  const [trajectoryQualityBySessionId, setTrajectoryQualityBySessionId] = useState<
    Record<string, AgentTrajectorySessionQualitySummary>
  >({});
  const mergeTrajectoryQualitySummary = useCallback(
    (sessionId: string, summary: AgentTrajectorySessionQualitySummary) => {
      setTrajectoryQualityBySessionId((current) => ({
        ...current,
        [sessionId]: summary,
      }));
    },
    [],
  );

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
      void ipcService
        .invoke(IPC_CHANNELS.SESSION_SEARCH, {
          query,
          options: { limit: 80, sessionIds },
        })
        .then((results) => {
          if (cancelled) return;
          const typedResults = results as CrossSessionSearchResults | null | undefined;
          setMessageSearchHitsBySessionId(
            buildSidebarMessageSearchHitGroups(typedResults?.results ?? [], allowedSessionIds),
          );
        })
        .catch((error) => {
          if (cancelled) return;
          logger.warn('Sidebar message search failed', {
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          setMessageSearchHitsBySessionId({});
        })
        .finally(() => {
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

  const hasActiveTrajectoryFilter =
    trajectoryTierFilter !== 'all' || trajectoryFailureFilter !== 'all' || trajectoryReviewFilter !== 'all';

  // Apply local metadata search, message-content hits, and session-native status filter.
  const baseFilteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sessions.filter((session) => {
      const status = getSessionStatusPresentation({
        backgroundSession: backgroundSessionMap.get(session.id),
        runtime: sessionRuntimes.get(session.id),
        taskState: sessionStates[session.id],
        messageCount: session.messageCount,
        turnCount: session.turnCount,
        sessionStatus: session.status,
        hasNeedsInput: hasNeedsInputForSession(session.id),
      });
      const hasPendingReview = (reviewItemsBySessionId[session.id] ?? []).some(
        (item) => item.reviewStatus === 'pending',
      ) || (sessionStatusFilter === 'review' && hasActiveTrajectoryFilter);
      if (
        !matchesSessionStatusFilter(sessionStatusFilter, status.kind, {
          hasDeliverySignals: hasSessionDeliverySignals(session, {
            hasReplay: replayEvidenceBySessionId.has(session.id),
          }),
          hasPendingReview,
        })
      ) {
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
    backgroundSessionMap,
    hasNeedsInputForSession,
    allowedSearchSessionIds,
    hasActiveTrajectoryFilter,
    messageSearchHitsBySessionId,
    replayEvidenceBySessionId,
    reviewItemsBySessionId,
    searchQuery,
    sessionRuntimes,
    sessionStatusFilter,
    sessions,
    sessionStates,
  ]);

  const filteredSessions = useMemo(() => {
    if (!hasActiveTrajectoryFilter) {
      return baseFilteredSessions;
    }
    return baseFilteredSessions.filter((session) => {
      const summary = trajectoryQualityBySessionId[session.id];
      const quality = summary?.quality;
      if (!quality) return false;
      if (trajectoryTierFilter !== 'all' && quality.tier !== trajectoryTierFilter) {
        return false;
      }
      if (trajectoryFailureFilter !== 'all' && !quality.failures.includes(trajectoryFailureFilter)) {
        return false;
      }
      if (!matchesTrajectoryReviewFilter(summary, trajectoryReviewFilter)) {
        return false;
      }
      return true;
    });
  }, [
    baseFilteredSessions,
    hasActiveTrajectoryFilter,
    trajectoryFailureFilter,
    trajectoryQualityBySessionId,
    trajectoryReviewFilter,
    trajectoryTierFilter,
  ]);

  const searchResultSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return searchableSessions
      .filter((session) => allowedSearchSessionIds.has(session.id))
      .filter((session) => {
        if (!query || messageSearchHitsBySessionId[session.id]) {
          return true;
        }
        const status = getSessionStatusPresentation({
          backgroundSession: backgroundSessionMap.get(session.id),
          runtime: sessionRuntimes.get(session.id),
          taskState: sessionStates[session.id],
          messageCount: session.messageCount,
          turnCount: session.turnCount,
          sessionStatus: session.status,
          hasNeedsInput: hasNeedsInputForSession(session.id),
        });
        return buildSessionSearchText({
          session,
          snapshot: session.workbenchSnapshot,
          status,
        }).includes(query);
      })
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  }, [
    allowedSearchSessionIds,
    backgroundSessionMap,
    hasNeedsInputForSession,
    messageSearchHitsBySessionId,
    searchQuery,
    sessionRuntimes,
    searchableSessions,
    sessionStates,
  ]);

  const trajectoryQualityCandidateSessionIds = useMemo(
    () => baseFilteredSessions.slice(0, TRAJECTORY_QUALITY_SIDEBAR_LIMIT).map((session) => session.id),
    [baseFilteredSessions],
  );
  const trajectoryQualityCandidateKey = trajectoryQualityCandidateSessionIds.join('\n');

  useEffect(() => {
    if (!canOpenSessionReplay || trajectoryQualityCandidateSessionIds.length === 0) {
      setTrajectoryQualityBySessionId({});
      return undefined;
    }

    let cancelled = false;
    void ipcService
      .invoke(IPC_CHANNELS.REPLAY_GET_TRAJECTORY_QUALITY, {
        sessionIds: trajectoryQualityCandidateSessionIds,
      })
      .then((itemsBySessionId) => {
        if (cancelled) return;
        setTrajectoryQualityBySessionId(itemsBySessionId ?? {});
      })
      .catch((error) => {
        if (cancelled) return;
        logger.warn('Failed to load sidebar trajectory quality', {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        setTrajectoryQualityBySessionId({});
      });

    return () => {
      cancelled = true;
    };
  }, [canOpenSessionReplay, trajectoryQualityCandidateKey, trajectoryQualityCandidateSessionIds]);

  // Pure workspace grouping (Codex-style): one bucket per workingDirectory,
  // sorted by latest activity; sessions without a workingDirectory go into a
  // trailing uncategorized bucket. No time sub-groups inside workspaces.
  const workspaceGroupedSessions = useMemo(
    // 设计草稿会话（工作目录在 .code-agent/design 下）不进聊天侧栏——设计模式有自己的历史。
    () =>
      groupByWorkspace(
        filteredSessions.filter((s) => {
          const wd = s.workingDirectory ?? '';
          // 同时匹配设计草稿基目录(.../design)与各 run 子目录(.../design/run-*)。
          const marker = DESIGN_WORKSPACE.DRAFT_PATH_MARKER; // '/.code-agent/design/'
          const base = marker.replace(/\/$/, ''); // '/.code-agent/design'
          return !(wd.includes(marker) || wd.endsWith(base));
        }),
      ).map((group) => ({
        ...group,
        sessions: sortSidebarSessionsForRecovery(
          group.sessions,
          (session) =>
            getSessionStatusPresentation({
              backgroundSession: backgroundSessionMap.get(session.id),
              runtime: sessionRuntimes.get(session.id),
              taskState: sessionStates[session.id],
              messageCount: session.messageCount,
              turnCount: session.turnCount,
              sessionStatus: session.status,
              hasNeedsInput: hasNeedsInputForSession(session.id),
            }).kind,
          (session) =>
            Math.max(
              session.updatedAt || 0,
              sessionRuntimes.get(session.id)?.lastActivityAt || 0,
              backgroundSessionMap.get(session.id)?.backgroundedAt || 0,
            ),
        ),
      })),
    [backgroundSessionMap, filteredSessions, hasNeedsInputForSession, sessionRuntimes, sessionStates],
  );
  const visibleProjectIds = useMemo(
    () =>
      Array.from(
        new Set(
          workspaceGroupedSessions
            .filter((group) => !group.isUncategorized)
            .map((group) => group.projectId?.trim())
            .filter((projectId): projectId is string => Boolean(projectId)),
        ),
      ).sort(),
    [workspaceGroupedSessions],
  );
  const [projectMetaById, setProjectMetaById] = useState<Record<string, SidebarProjectMeta>>({});
  // visibleProjectIds 已 .sort()，join 成内容稳定 key：活动轮里每条 SSE 事件都会重建
  // workspaceGroupedSessions → visibleProjectIds 变成新数组引用（内容不变）。若直接以数组引用做
  // effect 依赖，会随每个 token 重拉 project detail/artifacts 打爆 socket 池（ERR_INSUFFICIENT_RESOURCES）。
  // 与下方 visibleSessionIdsKey / trajectoryQualityCandidateKey 同款处理。
  const visibleProjectIdsKey = visibleProjectIds.join('\n');
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
    void Promise.all(
      visibleProjectIds.map(async (projectId): Promise<[string, SidebarProjectMeta] | null> => {
        try {
          const [detail, artifacts] = await Promise.all([getProjectDetail(projectId), getProjectArtifacts(projectId)]);
          const visibleGoals = detail.goals.filter((goal) => goal.status !== 'archived');
          const activeGoals = visibleGoals.filter((goal) => goal.status === 'active');
          const sortedGoals = [...visibleGoals].sort((left, right) => {
            const statusRank = (status: typeof left.status) => (status === 'active' ? 0 : status === 'aborted' ? 1 : 2);
            const rankDiff = statusRank(left.status) - statusRank(right.status);
            if (rankDiff !== 0) return rankDiff;
            return (right.updatedAt || 0) - (left.updatedAt || 0);
          });
          return [
            projectId,
            {
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
            },
          ];
        } catch (error) {
          logger.warn('Failed to load sidebar project summary', {
            projectId,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setProjectMetaById(
        Object.fromEntries(entries.filter((entry): entry is [string, SidebarProjectMeta] => entry !== null)),
      );
    });

    return () => {
      cancelled = true;
    };
    // 依赖 visibleProjectIdsKey（内容稳定）而非 visibleProjectIds（每次渲染新引用），
    // 否则活动轮里每个 SSE tick 都会重拉 → 请求风暴。
  }, [visibleProjectIdsKey]);

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
    void ipcService
      .invoke(IPC_CHANNELS.SESSION_LIST_REVIEW_ITEMS, request)
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
    backgroundSessionMap,
    replayEvidenceBySessionId,
    hasNeedsInputForSession,
    hasPendingApprovalForSession,
    currentProjectSearchSessionIds,
    effectiveSearchScope,
    searchScope,
    setSearchScope,
    allowedSearchSessionIds,
    messageSearchHitsBySessionId,
    messageSearchLoading,
    searchResultSessions,
    reviewItemsBySessionId,
    trajectoryQualityBySessionId,
    mergeTrajectoryQualitySummary,
    filteredSessions,
    workspaceGroupedSessions,
    visibleProjectIds,
    visibleSessionIds,
    projectMetaById,
    setProjectMetaById,
  };
}
