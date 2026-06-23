import React from 'react';
import {
  Archive,
  ArchiveRestore,
  CheckSquare,
  Eye,
  Pin,
  ScrollText,
  ShieldAlert,
  Square,
} from 'lucide-react';
import type { SessionRuntimeSummary } from '@shared/ipc';
import type { SessionAutomationSessionSummary } from '@shared/contract';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import type { SessionState } from '../../../stores/taskStore';
import { getDisplaySessionTitle, getSessionAttentionDot, getSessionStatusPresentation } from '../../../utils/sessionPresentation';
import { type SessionReplayEvidence } from '../../../utils/sessionReplayEvidence';
import { canReuseSessionWorkbench, getRelativeTime } from './sidebarPresentation';
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

function formatReplayEvidenceButtonTitle(
  evidence: SessionReplayEvidence,
  canOpenSessionReplay: boolean,
): string {
  if (evidence.actionKind !== 'sessionReplay' || canOpenSessionReplay) {
    return evidence.title;
  }
  return `${evidence.title}\n结构化 Replay 仅管理员可打开`;
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
  multiSelectMode,
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
  const messageSearchHitGroup = searchQuery.trim() ? messageSearchHitsBySessionId[session.id] : undefined;
  const lastActiveLabel = getRelativeTime(latestActivityAt, true);
  const displayTitle = getDisplaySessionTitle(session.title);
  const canOpenSessionAssets = canReuseSessionWorkbench(session);
  const replayEvidence = replayEvidenceBySessionId.get(session.id) ?? [];
  const pendingReviewItems = (reviewItemsBySessionId[session.id] ?? [])
    .filter((item) => item.reviewStatus === 'pending');
  const topReviewItem = pendingReviewItems[0];
  // 待办圆点：仅 出错(红)/待确认(蓝)，取代原来的文字状态徽章；问题解决后状态变化、点自然消失。
  const attentionDot = getSessionAttentionDot(status.kind);

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
      className={`group relative px-3 py-2 rounded-lg cursor-pointer transition-all duration-150 ${
        isSelected && !multiSelectMode
          ? 'bg-zinc-700/60'
          : isChecked
            ? 'bg-blue-500/10 border border-blue-500/20'
            : 'hover:bg-zinc-800'
      }`}
    >
      {/* 多选模式：Checkbox */}
      {multiSelectMode && (
        <div className="flex items-center mb-1">
          {isChecked ? (
            <CheckSquare className="w-4 h-4 text-blue-400" />
          ) : (
            <Square className="w-4 h-4 text-zinc-500" />
          )}
        </div>
      )}

      {/* 单行：未读点 + 置顶 + 标题 + 右侧区（默认 轮次·时间·待办圆点 / hover 动作图标，display 切换互斥不重叠） */}
      <div className="flex items-center gap-2">
        {isUnread && !multiSelectMode && (
          <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-purple-500" aria-label="未读" />
        )}
        {isPinned && !multiSelectMode && (
          <Pin className="w-3 h-3 text-amber-500 shrink-0 -rotate-45" />
        )}

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
            className={`text-sm truncate font-medium flex-1 ${
              isSelected ? 'text-zinc-100' : 'text-zinc-400'
            }`}
          >
            {displayTitle}
          </span>
        )}

        {!multiSelectMode && !isRenaming && (
          <div className="shrink-0 flex items-center gap-1.5">
            {/* 待审 review：常显可点徽章(admin 信号,带计数),不随 hover 切换 */}
            {topReviewItem && (
              <button
                type="button"
                aria-label={`打开 ${displayTitle} 的 Review 证据`}
                title={`${pendingReviewItems.length} 个待审 issue · ${topReviewItem.title}`}
                onClick={(event) => { event.preventDefault(); event.stopPropagation(); void handleOpenSessionReplay(session); }}
                className="inline-flex items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 transition-colors hover:border-amber-400/30 hover:bg-amber-500/15 hover:text-amber-200 focus:outline-hidden"
              >
                <ShieldAlert className="h-3 w-3" />
                <span>{pendingReviewItems.length} 待审</span>
              </button>
            )}
            {/* 默认态：轮次·时间 + 待办圆点 */}
            <div className="flex items-center gap-1.5 group-hover:hidden">
              <span className="text-[10px] text-zinc-600 whitespace-nowrap">
                {(session.turnCount ?? 0) > 0 ? `${session.turnCount} 轮 · ${lastActiveLabel}` : lastActiveLabel}
              </span>
              {attentionDot && (
                <span
                  aria-label={attentionDot.label}
                  title={attentionDot.label}
                  className={`h-2 w-2 rounded-full ${attentionDot.colorClassName}`}
                />
              )}
            </div>
            {/* hover 态：动作图标（取代默认态，不与之同时占位） */}
            <div className="hidden items-center gap-0.5 group-hover:flex">
              {canOpenSessionReplay && sessionHasActivity && (
                <button
                  type="button"
                  aria-label={`打开 ${displayTitle} Replay`}
                  title={`打开 ${displayTitle} Replay`}
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); void handleOpenSessionReplay(session); }}
                  className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              )}
              {canOpenSessionAssets && (
                <button
                  type="button"
                  aria-label={`打开 ${displayTitle} 的产物与资产`}
                  title={`打开 ${displayTitle} 的产物与资产`}
                  onClick={(event) => { void handleOpenSessionAssets(event, session); }}
                  className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
                >
                  <ScrollText className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                aria-label={session.isArchived ? '取消归档' : '归档'}
                title={session.isArchived ? '取消归档' : '归档'}
                onClick={(e) => handleArchiveSession(session.id, !!session.isArchived, e)}
                className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
              >
                {session.isArchived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 回放证据（仅 workflow/trace 等少数会话才有的 admin 链路；普通会话不出现，故不破坏单行） */}
      {!isRenaming && replayEvidence.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden text-[10px] text-zinc-500">
          {replayEvidence.slice(0, 2).map((evidence) => (
            <button
              key={evidence.id}
              type="button"
              aria-label={canOpenSessionReplay || evidence.actionKind !== 'sessionReplay'
                ? `打开 ${displayTitle} 的 ${evidence.label}`
                : `Replay 仅管理员可用：${displayTitle} 的 ${evidence.label}`}
              title={formatReplayEvidenceButtonTitle(evidence, canOpenSessionReplay)}
              disabled={evidence.actionKind === 'sessionReplay' && !canOpenSessionReplay}
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); void handleOpenReplayEvidence(session, evidence); }}
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

      {/* 搜索命中子列表（仅搜索时） */}
      {!isRenaming && messageSearchHitGroup && (
        <SidebarMessageHitList
          sessionId={session.id}
          hits={messageSearchHitGroup.hits}
          onSelectHit={handleSelectMessageSearchHit}
        />
      )}
    </div>
  );
};
