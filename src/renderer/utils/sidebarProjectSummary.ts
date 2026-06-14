import type { BackgroundTaskInfo } from '@shared/contract/sessionState';
import type { AdminReviewQueueItem } from '@shared/contract/productClosure';
import type { ProjectArtifact, ProjectGoalStatus, ProjectStatus } from '@shared/contract/project';
import type { SessionRuntimeSummary } from '@shared/ipc';
import type { SessionState as TaskSessionState } from '../stores/taskStore';
import type { WorkspaceGroup } from './workspaceGrouping';
import { getSessionStatusPresentation } from './sessionPresentation';

export interface SidebarProjectGoalMeta {
  id: string;
  title: string;
  verify?: string | null;
  review?: string | null;
  status: ProjectGoalStatus;
  updatedAt?: number;
  lastRunSessionId?: string | null;
}

export interface SidebarProjectArtifactMeta {
  id: string;
  sessionId: string;
  messageId?: string;
  title: string;
  kind: ProjectArtifact['kind'];
  sessionTitle?: string;
  createdAt: number;
  path?: string;
  url?: string;
  toolCallId?: string;
  toolName?: string;
  previewItemId?: string;
}

export interface SidebarProjectMeta {
  name?: string;
  status?: ProjectStatus;
  description?: string;
  goalCount?: number;
  activeGoalTitles?: string[];
  goals?: SidebarProjectGoalMeta[];
  roleCount?: number;
  roleIds?: string[];
  artifactCount?: number;
  recentArtifactTitles?: string[];
  recentArtifacts?: SidebarProjectArtifactMeta[];
  sessionCount?: number;
  updatedAt?: number;
}

export interface SidebarProjectSummary {
  displayName: string;
  sessionCount: number;
  unfinishedCount: number;
  pendingApprovalCount: number;
  attentionCount: number;
  runningCount: number;
  reviewIssueCount: number;
  artifactCount?: number;
  goalCount?: number;
  activeGoalTitle?: string;
  latestActivityAt: number;
}

export interface BuildSidebarProjectSummaryArgs {
  group: WorkspaceGroup;
  backgroundTaskMap: Map<string, BackgroundTaskInfo>;
  sessionRuntimes: Map<string, SessionRuntimeSummary>;
  sessionStates: Record<string, TaskSessionState | undefined>;
  hasPendingApprovalForSession: (sessionId: string) => boolean;
  reviewItemsBySessionId?: Record<string, AdminReviewQueueItem[]>;
  projectMeta?: SidebarProjectMeta;
}

export function buildSidebarProjectSummary({
  group,
  backgroundTaskMap,
  sessionRuntimes,
  sessionStates,
  hasPendingApprovalForSession,
  reviewItemsBySessionId,
  projectMeta,
}: BuildSidebarProjectSummaryArgs): SidebarProjectSummary {
  let pendingApprovalCount = 0;
  let attentionCount = 0;
  let runningCount = 0;
  let reviewIssueCount = 0;
  let latestActivityAt = group.latestActivityAt || 0;

  for (const session of group.sessions) {
    const backgroundTask = backgroundTaskMap.get(session.id);
    const runtime = sessionRuntimes.get(session.id);
    const status = getSessionStatusPresentation({
      backgroundTask,
      runtime,
      taskState: sessionStates[session.id],
      messageCount: session.messageCount,
      turnCount: session.turnCount,
      sessionStatus: session.status,
      hasPendingApproval: hasPendingApprovalForSession(session.id),
    });

    if (status.kind === 'approval') {
      pendingApprovalCount += 1;
    } else if (status.kind === 'background' || status.kind === 'live') {
      runningCount += 1;
    } else if (status.kind === 'paused' || status.kind === 'error' || status.kind === 'incomplete') {
      attentionCount += 1;
    }
    reviewIssueCount += (reviewItemsBySessionId?.[session.id] ?? [])
      .filter((item) => item.reviewStatus === 'pending')
      .length;

    latestActivityAt = Math.max(
      latestActivityAt,
      session.updatedAt || 0,
      runtime?.lastActivityAt || 0,
      backgroundTask?.backgroundedAt || 0,
    );
  }

  return {
    displayName: group.isUncategorized ? '未分类' : projectMeta?.name || group.name,
    sessionCount: projectMeta?.sessionCount ?? group.sessions.length,
    unfinishedCount: pendingApprovalCount + attentionCount + runningCount,
    pendingApprovalCount,
    attentionCount,
    runningCount,
    reviewIssueCount,
    artifactCount: projectMeta?.artifactCount,
    goalCount: projectMeta?.goalCount,
    activeGoalTitle: projectMeta?.activeGoalTitles?.find((title) => title.trim())?.trim(),
    latestActivityAt,
  };
}

function formatWorkspacePathLabel(path?: string): string | null {
  const trimmed = path?.trim().replace(/[\\/]+$/, '');
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) {
    return parts.join('/');
  }
  return `.../${parts.slice(-2).join('/')}`;
}

function truncateSummaryItem(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatCompactRelativeTime(timestamp: number, now = Date.now()): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const diff = now - timestamp;
  if (!Number.isFinite(diff) || diff < 0) return '';
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

export interface FormatSidebarProjectSummaryLineOptions {
  summary: SidebarProjectSummary;
  isUncategorized: boolean;
  isFiltered: boolean;
  workspacePaths: string[];
  now?: number;
}

export function formatSidebarProjectSummaryLine({
  summary,
  isUncategorized,
  isFiltered,
  workspacePaths,
  now,
}: FormatSidebarProjectSummaryLineOptions): string {
  const items: string[] = [];
  if (isUncategorized) {
    items.push('空白会话');
  } else {
    const pathLabel = formatWorkspacePathLabel(workspacePaths[0]);
    if (pathLabel) {
      items.push(workspacePaths.length > 1 ? `${pathLabel} +${workspacePaths.length - 1} 工作区` : pathLabel);
    }
    if (summary.activeGoalTitle) {
      items.push(`目标：${truncateSummaryItem(summary.activeGoalTitle, 24)}`);
    }
  }
  if (summary.pendingApprovalCount > 0) {
    items.push(`${summary.pendingApprovalCount} 待确认`);
  }
  if (summary.runningCount > 0) {
    items.push(`${summary.runningCount} 执行中`);
  }
  if (summary.attentionCount > 0) {
    items.push(`${summary.attentionCount} 待处理`);
  }
  if (summary.reviewIssueCount > 0) {
    items.push(`${summary.reviewIssueCount} 待审`);
  }
  if (typeof summary.goalCount === 'number') {
    items.push(`${summary.goalCount} 目标`);
  }
  if (typeof summary.artifactCount === 'number') {
    items.push(`${summary.artifactCount} 产物`);
  }
  items.push(`${summary.sessionCount} ${isFiltered ? '命中' : '会话'}`);
  const relative = formatCompactRelativeTime(summary.latestActivityAt, now);
  if (relative) {
    items.push(`最近 ${relative}`);
  }
  return items.join(' · ');
}
