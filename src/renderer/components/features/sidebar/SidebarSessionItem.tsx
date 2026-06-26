import React from 'react';
import { Archive, ArchiveRestore, CheckSquare, Clock3, Eye, Pin, ScrollText, ShieldAlert, Square } from 'lucide-react';
import type { SessionRuntimeSummary } from '@shared/ipc';
import type { SessionAutomationSessionSummary } from '@shared/contract';
import { IconButton } from '../../primitives';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import type { SessionState } from '../../../stores/taskStore';
import { getDisplaySessionTitle, getSessionStatusPresentation } from '../../../utils/sessionPresentation';
import { buildSessionRecoveryHints } from '../../../utils/sessionRecoveryHints';
import {
  formatSidebarMessageSearchHitLabel,
  formatSidebarMessageSearchHitMeta,
} from '../../../utils/sidebarMessageSearch';
import { type SessionReplayEvidence } from '../../../utils/sessionReplayEvidence';
import { canReuseSessionWorkbench, getRelativeTime } from './sidebarPresentation';
import { getSessionTypeLabel } from './SessionTypeFilterBar';
import { SidebarMessageHitList } from './SidebarMessageHitList';
import type { SidebarDerivedSessions } from './useSidebarDerivedSessions';
import type { SidebarSessionActions } from './useSidebarSessionActions';
import type { SidebarRowActions } from './useSidebarRowActions';

function formatReplayEvidenceOverflowTitle(evidence: SessionReplayEvidence[]): string {
  return evidence
    .slice(2)
    .map((item) => `${item.type === 'trace' ? 'Trace' : 'Replay'} · ${item.label}`)
    .join('\n');
}

function formatReplayEvidenceButtonTitle(evidence: SessionReplayEvidence, canOpenSessionReplay: boolean): string {
  if (evidence.actionKind !== 'sessionReplay' || canOpenSessionReplay) {
    return evidence.title;
  }
  return `${evidence.title}\n结构化 Replay 仅管理员可打开`;
}

function getTrajectoryDatasetLabel(role: string): string {
  switch (role) {
    case 'core_eval':
      return 'Core';
    case 'excluded':
      return 'Out';
    default:
      return 'Diag';
  }
}

function getTrajectoryQualityToneClassName(tier: string): string {
  switch (tier) {
    case 'G2':
      return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
    case 'G1':
      return 'border-amber-500/25 bg-amber-500/10 text-amber-300';
    default:
      return 'border-rose-500/25 bg-rose-500/10 text-rose-300';
  }
}

function getEvidenceControlToneClassName(trustLevel: string): string {
  switch (trustLevel) {
    case 'strong':
      return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
    case 'partial':
      return 'border-amber-500/25 bg-amber-500/10 text-amber-300';
    default:
      return 'border-rose-500/25 bg-rose-500/10 text-rose-300';
  }
}

function formatTrajectoryQualityTitle(summary: SidebarDerivedSessions['trajectoryQualityBySessionId'][string]): string {
  const quality = summary.quality;
  const collection = summary.collection;
  const failures = quality.failures.length > 0 ? quality.failures.slice(0, 8).join(' · ') : 'no gate failures';
  return [
    `Trajectory ${quality.tier}`,
    collection.datasetRole,
    collection.taskKind,
    `${collection.datasetVersion} · ${collection.source}`,
    failures,
  ].join('\n');
}

function sanitizeEvidenceControlText(value: string): string {
  return value
    .replace(/^data:[^\s]+/gi, '[redacted]')
    .replace(/base64[,=][^\s]+/gi, 'base64,[redacted]')
    .replace(
      /(?:\/Users\/[^\s"'`]+|\/private\/tmp\/[^\s"'`]+|\/tmp\/[^\s"'`]+|\/var\/folders\/[^\s"'`]+|\/Volumes\/[^\s"'`]+)(?:\/[^\s"'`]*)*/g,
      (match) => `.../${match.split('/').filter(Boolean).at(-1) || 'path'}`,
    )
    .replace(/\b(cookie|cookies|localStorage|sessionStorage|storageState)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/([?&](?:token|password|secret|credential)=)[^&\s]+/gi, '$1[redacted]');
}

function formatEvidenceControlTitle(summary: SidebarDerivedSessions['trajectoryQualityBySessionId'][string]): string {
  const evidence = summary.evidenceControl;
  if (!evidence) return 'No Evidence Control summary';
  const gaps = evidence.gaps.length > 0
    ? evidence.gaps.slice(0, 8).map(sanitizeEvidenceControlText).join(' · ')
    : 'no evidence gaps';
  const conflicts = evidence.conflicts.length > 0
    ? evidence.conflicts.slice(0, 5).map(sanitizeEvidenceControlText).join(' · ')
    : 'no conflicts';
  return [
    `Evidence Control ${evidence.trustLevel}`,
    `${evidence.totalItems} items · ${evidence.totalEvidenceRefs} refs`,
    `blocked ${evidence.blockedItems} · stale ${evidence.staleItems} · conflicts ${evidence.conflictItems}`,
    gaps,
    conflicts,
  ].join('\n');
}

export interface SidebarSessionItemProps {
  session: SessionWithMeta;
  unreadSessionIds: Set<string>;
  automationSummariesBySessionId: Record<string, SessionAutomationSessionSummary>;
  currentSessionId: string | null;
  selectedSessionIds: Set<string>;
  pinnedSessionIds: Set<string>;
  renamingId: string | null;
  sessionRuntimes: Map<string, SessionRuntimeSummary>;
  backgroundTaskMap: SidebarDerivedSessions['backgroundTaskMap'];
  sessionStates: Record<string, SessionState>;
  hasPendingApprovalForSession: SidebarDerivedSessions['hasPendingApprovalForSession'];
  searchQuery: string;
  messageSearchHitsBySessionId: SidebarDerivedSessions['messageSearchHitsBySessionId'];
  replayEvidenceBySessionId: SidebarDerivedSessions['replayEvidenceBySessionId'];
  canOpenSessionReplay: boolean;
  reviewItemsBySessionId: SidebarDerivedSessions['reviewItemsBySessionId'];
  trajectoryQualityBySessionId: SidebarDerivedSessions['trajectoryQualityBySessionId'];
  multiSelectMode: boolean;
  hoveredSession: string | null;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  setHoveredSession: (id: string | null) => void;
  setRenameValue: (value: string) => void;
  handleSelectSession: SidebarSessionActions['handleSelectSession'];
  handleContextMenu: SidebarRowActions['handleContextMenu'];
  handleRenameSubmit: SidebarRowActions['handleRenameSubmit'];
  handleRenameKeyDown: SidebarRowActions['handleRenameKeyDown'];
  handleDoubleClick: SidebarRowActions['handleDoubleClick'];
  handleOpenSessionReplay: SidebarRowActions['handleOpenSessionReplay'];
  handleOpenSessionAssets: SidebarSessionActions['handleOpenSessionAssets'];
  handleOpenReplayEvidence: SidebarRowActions['handleOpenReplayEvidence'];
  handleSelectMessageSearchHit: SidebarSessionActions['handleSelectMessageSearchHit'];
  handleArchiveSession: SidebarSessionActions['handleArchiveSession'];
}

/** SidebarSessionItem 除 `session` 外的共享 props，供 SidebarProjectGroup 按会话批量透传。 */
export type SidebarSessionItemSharedProps = Omit<SidebarSessionItemProps, 'session'>;

/**
 * 单条会话行。从 `Sidebar` 巨型组件的 `renderSessionItem` 抽出为独立组件，
 * 闭包读取的组件作用域值经 props 透传，零行为改动。
 */
export const SidebarSessionItem: React.FC<SidebarSessionItemProps> = ({
  session,
  unreadSessionIds,
  automationSummariesBySessionId,
  currentSessionId,
  selectedSessionIds,
  pinnedSessionIds,
  renamingId,
  sessionRuntimes,
  backgroundTaskMap,
  sessionStates,
  hasPendingApprovalForSession,
  searchQuery,
  messageSearchHitsBySessionId,
  replayEvidenceBySessionId,
  canOpenSessionReplay,
  reviewItemsBySessionId,
  trajectoryQualityBySessionId,
  multiSelectMode,
  hoveredSession,
  renameValue,
  renameInputRef,
  setHoveredSession,
  setRenameValue,
  handleSelectSession,
  handleContextMenu,
  handleRenameSubmit,
  handleRenameKeyDown,
  handleDoubleClick,
  handleOpenSessionReplay,
  handleOpenSessionAssets,
  handleOpenReplayEvidence,
  handleSelectMessageSearchHit,
  handleArchiveSession,
}) => {
  const isUnread = unreadSessionIds.has(session.id);
  const isSelected = currentSessionId === session.id;
  const isChecked = selectedSessionIds.has(session.id);
  const isPinned = pinnedSessionIds.has(session.id);
  const isRenaming = renamingId === session.id;
  const sessionRuntime = sessionRuntimes.get(session.id);
  const backgroundTask = backgroundTaskMap.get(session.id);
  // 空会话（0 轮 / 0 消息）没有可回放内容，行内不展示 Replay 入口，避免「新对话」上挂个没用的图标。
  const sessionHasActivity = (session.turnCount ?? 0) > 0 || (session.messageCount ?? 0) > 0;
  const status = getSessionStatusPresentation({
    backgroundTask,
    runtime: sessionRuntime,
    taskState: sessionStates[session.id],
    messageCount: session.messageCount,
    turnCount: session.turnCount,
    sessionStatus: session.status,
    hasPendingApproval: hasPendingApprovalForSession(session.id),
  });
  const latestActivityAt = Math.max(
    session.updatedAt || 0,
    sessionRuntime?.lastActivityAt || 0,
    backgroundTask?.backgroundedAt || 0,
  );
  const snapshotSummary = session.workbenchSnapshot?.summary?.trim() || '';
  const hasMeaningfulSummary = snapshotSummary && snapshotSummary !== '纯对话';
  const messageSearchHitGroup = searchQuery.trim() ? messageSearchHitsBySessionId[session.id] : undefined;
  const messageSearchHit = messageSearchHitGroup?.bestHit;
  const lastActiveLabel = getRelativeTime(latestActivityAt, true);
  const typeLabel = getSessionTypeLabel(session.type);
  const automationSummary = automationSummariesBySessionId[session.id];
  const showAutomationBadge = Boolean(
    automationSummary?.label && (automationSummary.activeCount > 0 || automationSummary.runningCount > 0),
  );
  const displayTitle = getDisplaySessionTitle(session.title);
  const canOpenSessionAssets = canReuseSessionWorkbench(session);
  const replayEvidence = replayEvidenceBySessionId.get(session.id) ?? [];
  const hasReplaySignal = replayEvidence.length > 0;
  const recoveryHints = buildSessionRecoveryHints(session, {
    hasReplay: hasReplaySignal,
    canOpenReplay: canOpenSessionReplay,
  });
  const pendingReviewItems = (reviewItemsBySessionId[session.id] ?? []).filter(
    (item) => item.reviewStatus === 'pending',
  );
  const topReviewItem = pendingReviewItems[0];
  const trajectoryQualitySummary = trajectoryQualityBySessionId[session.id];
  const trajectoryQuality = trajectoryQualitySummary?.quality;
  const trajectoryCollection = trajectoryQualitySummary?.collection;
  const evidenceControl = trajectoryQualitySummary?.evidenceControl;

  return (
    <div
      key={session.id}
      onClick={() => handleSelectSession(session.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void handleSelectSession(session.id);
        }
      }}
      onContextMenu={(e) => handleContextMenu(e, session)}
      onMouseEnter={() => setHoveredSession(session.id)}
      onMouseLeave={() => setHoveredSession(null)}
      role="button"
      tabIndex={0}
      aria-current={isSelected && !multiSelectMode ? 'true' : undefined}
      aria-label={`打开会话 ${displayTitle}`}
      data-session-id={session.id}
      className={`group relative px-3 py-2 rounded-lg cursor-pointer transition-all duration-150 ${isSelected && !multiSelectMode ? 'bg-zinc-700/60' : isChecked ? 'bg-blue-500/10 border border-blue-500/20' : 'hover:bg-zinc-800'}`}
    >
      {/* 多选模式：Checkbox */}
      {multiSelectMode && (
        <div className="flex items-center mb-1">
          {isChecked ? <CheckSquare className="w-4 h-4 text-blue-400" /> : <Square className="w-4 h-4 text-zinc-500" />}
        </div>
      )}

      {/* Line 1: status indicators + title */}
      <div className="flex items-center gap-2">
        {/* 置顶图标 */}
        {isPinned && !multiSelectMode && <Pin className="w-3 h-3 text-amber-500 shrink-0 -rotate-45" />}

        {/* 标题：重命名模式 vs 普通 */}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={handleRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 text-sm bg-zinc-600/80 text-zinc-200 px-1.5 py-0.5 rounded border border-zinc-600 focus:border-blue-500 focus:outline-hidden"
          />
        ) : (
          <span
            onDoubleClick={(e) => handleDoubleClick(e, session)}
            className={`text-sm truncate font-medium flex-1 ${isSelected ? 'text-zinc-100' : 'text-zinc-400'}`}
          >
            {displayTitle}
          </span>
        )}

        {!multiSelectMode && !isRenaming && (
          <>
            {/* D-9: Replay 仅管理员可用 — 非管理员直接不渲染；空会话也不渲染（无可回放内容） */}
            {canOpenSessionReplay && sessionHasActivity && (
              <button
                type="button"
                aria-label={`打开 ${displayTitle} Replay`}
                title={`打开 ${displayTitle} Replay`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void handleOpenSessionReplay(session);
                }}
                className="shrink-0 rounded-md p-1 text-zinc-500 opacity-0 transition-all hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden group-hover:opacity-100"
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
            )}
            {topReviewItem && (
              <button
                type="button"
                aria-label={`打开 ${displayTitle} 的 Review 证据`}
                title={`${pendingReviewItems.length} 个待审 issue · ${topReviewItem.title}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void handleOpenSessionReplay(session);
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 transition-colors hover:border-amber-400/30 hover:bg-amber-500/15 hover:text-amber-200 focus:outline-hidden"
              >
                <ShieldAlert className="h-3 w-3" />
                <span>{pendingReviewItems.length} 待审</span>
              </button>
            )}
            {trajectoryQualitySummary && trajectoryQuality && trajectoryCollection && (
              <span
                title={formatTrajectoryQualityTitle(trajectoryQualitySummary)}
                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${getTrajectoryQualityToneClassName(trajectoryQuality.tier)}`}
              >
                {trajectoryQuality.tier} · {getTrajectoryDatasetLabel(trajectoryCollection.datasetRole)}
              </span>
            )}
            {trajectoryQualitySummary && evidenceControl && (
              <span
                title={formatEvidenceControlTitle(trajectoryQualitySummary)}
                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${getEvidenceControlToneClassName(evidenceControl.trustLevel)}`}
              >
                EV {evidenceControl.trustLevel}
              </span>
            )}
            {canOpenSessionAssets && (
              <button
                type="button"
                aria-label={`打开 ${displayTitle} 的产物与资产`}
                title={`打开 ${displayTitle} 的产物与资产`}
                onClick={(event) => {
                  void handleOpenSessionAssets(event, session);
                }}
                className="shrink-0 rounded-md p-1 text-zinc-500 opacity-0 transition-all hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden group-hover:opacity-100"
              >
                <ScrollText className="h-3.5 w-3.5" />
              </button>
            )}
            {typeLabel && (
              <span className="shrink-0 rounded-full border border-zinc-700 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 transition-opacity duration-150 group-hover:opacity-0">
                {typeLabel}
              </span>
            )}
            {showAutomationBadge && automationSummary && (
              <span
                title={automationSummary.tooltip || '会话自动化'}
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 transition-opacity duration-150 group-hover:opacity-0"
              >
                <Clock3 className="h-3 w-3" />
                <span>{automationSummary.label}</span>
              </span>
            )}
            {status.showBadge && (
              <span
                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium transition-opacity duration-150 group-hover:opacity-0 ${status.toneClassName}`}
              >
                {status.label}
              </span>
            )}
          </>
        )}
      </div>

      {/* Line 2: summary + recent activity */}
      {!isRenaming && (
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-600">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {messageSearchHit ? (
              <span className="truncate text-zinc-400">
                <span className="text-zinc-500">{formatSidebarMessageSearchHitMeta(messageSearchHit)}</span>
                <span> · {formatSidebarMessageSearchHitLabel(messageSearchHit)}</span>
              </span>
            ) : (
              hasMeaningfulSummary && <span className="truncate text-zinc-500">{snapshotSummary}</span>
            )}
            {recoveryHints.map((hint) => (
              <span
                key={`${session.id}:${hint.kind}:${hint.label}`}
                title={hint.title}
                className="shrink-0 rounded border border-zinc-700/60 bg-zinc-900/70 px-1 py-0.5 text-[10px] font-medium text-zinc-500"
              >
                {hint.label}
              </span>
            ))}
          </span>
          <span className="text-[10px] text-zinc-600 shrink-0">
            {(session.turnCount ?? 0) > 0 ? `${session.turnCount} 轮 · ${lastActiveLabel}` : lastActiveLabel}
          </span>
        </div>
      )}

      {!isRenaming && replayEvidence.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden text-[10px] text-zinc-500">
          {replayEvidence.slice(0, 2).map((evidence) => (
            <button
              key={evidence.id}
              type="button"
              aria-label={
                canOpenSessionReplay || evidence.actionKind !== 'sessionReplay'
                  ? `打开 ${displayTitle} 的 ${evidence.label}`
                  : `Replay 仅管理员可用：${displayTitle} 的 ${evidence.label}`
              }
              title={formatReplayEvidenceButtonTitle(evidence, canOpenSessionReplay)}
              disabled={evidence.actionKind === 'sessionReplay' && !canOpenSessionReplay}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void handleOpenReplayEvidence(session, evidence);
              }}
              className="inline-flex min-w-0 shrink items-center gap-1 rounded border border-zinc-700/60 bg-zinc-900/50 px-1.5 py-0.5 text-zinc-500 transition-colors hover:border-zinc-600 hover:bg-zinc-800/80 hover:text-zinc-300 focus:outline-hidden disabled:cursor-not-allowed disabled:hover:border-zinc-700/60 disabled:hover:bg-zinc-900/50 disabled:hover:text-zinc-500"
            >
              <span className="shrink-0 text-zinc-600">{evidence.type === 'trace' ? 'Trace' : 'Replay'}</span>
              <span className="truncate">{evidence.label}</span>
            </button>
          ))}
          {replayEvidence.length > 2 && (
            <span
              title={formatReplayEvidenceOverflowTitle(replayEvidence)}
              className="shrink-0 rounded border border-zinc-700/60 bg-zinc-900/50 px-1.5 py-0.5 text-zinc-600"
            >
              +{replayEvidence.length - 2}
            </span>
          )}
        </div>
      )}

      {!isRenaming && messageSearchHitGroup && (
        <SidebarMessageHitList
          sessionId={session.id}
          hits={messageSearchHitGroup.hits}
          onSelectHit={handleSelectMessageSearchHit}
        />
      )}

      {/* Hover actions — absolute positioned top-right */}
      {hoveredSession === session.id && !multiSelectMode && !isRenaming && (
        <div className="absolute top-1.5 right-2 flex items-center gap-0.5">
          <IconButton
            icon={session.isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
            aria-label={session.isArchived ? 'Unarchive session' : 'Archive session'}
            onClick={(e) => handleArchiveSession(session.id, !!session.isArchived, e)}
            variant="ghost"
            size="sm"
            className="!p-1 opacity-0 group-hover:opacity-100"
            title={session.isArchived ? '取消归档' : '归档'}
          />
        </div>
      )}

      {/* 未读指示器 */}
      {isUnread && !multiSelectMode && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 w-2 h-2 bg-purple-500 rounded-full" />
      )}
    </div>
  );
};
