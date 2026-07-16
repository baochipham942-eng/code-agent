import React from 'react';
import { Archive, ArchiveRestore, CheckSquare, Eye, Loader2, Pin, ScrollText, Square } from 'lucide-react';
import type { SessionRuntimeSummary } from '@shared/ipc';
import type { SessionAutomationSessionSummary } from '@shared/contract';
import { IconButton } from '../../primitives';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import type { SessionState } from '../../../stores/taskStore';
import { getDisplaySessionTitle, getSessionStatusPresentation } from '../../../utils/sessionPresentation';
import { canReuseSessionWorkbench, getRelativeTime } from './sidebarPresentation';
import { SidebarMessageHitList } from './SidebarMessageHitList';
import type { SidebarDerivedSessions } from './useSidebarDerivedSessions';
import type { SidebarSessionActions } from './useSidebarSessionActions';
import type { SidebarRowActions } from './useSidebarRowActions';

/**
 * 需要关注但非运行中的状态，行尾显一个安静的小圆点（不是带文字的彩色 chip），
 * 颜色对齐 sessionPresentation 的语义色，保持「标题 + 时间」的克制版式。
 */
function getAttentionDotClassName(kind: string): string | null {
  switch (kind) {
    case 'error':
      return 'bg-red-400';
    case 'approval':
      return 'bg-violet-400';
    case 'paused':
      return 'bg-amber-400';
    case 'incomplete':
      return 'bg-amber-400/60';
    default:
      return null;
  }
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
  hasNeedsInputForSession: SidebarDerivedSessions['hasNeedsInputForSession'];
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
 * 单条会话行（Codex 风极简版）：默认只显「标题 + 右侧时间」，运行中显 spinner，
 * 需关注状态显一个安静小圆点；Replay/产物/归档等动作 hover 才浮现。
 * eval 诊断（轨迹质量 / 证据等级）、类型/自动化徽标、摘要行、Replay 证据按钮
 * 全部移出默认行——它们仍可经项目控制台 / Replay 面板查看，不再喧宾夺主。
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
  hasNeedsInputForSession,
  searchQuery,
  messageSearchHitsBySessionId,
  canOpenSessionReplay,
  multiSelectMode,
  renameValue,
  renameInputRef,
  setRenameValue,
  handleSelectSession,
  handleContextMenu,
  handleRenameSubmit,
  handleRenameKeyDown,
  handleDoubleClick,
  handleOpenSessionReplay,
  handleOpenSessionAssets,
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
  // 空会话（0 轮 / 0 消息）没有可回放内容，hover 也不挂 Replay 入口。
  const sessionHasActivity = (session.turnCount ?? 0) > 0 || (session.messageCount ?? 0) > 0;
  const status = getSessionStatusPresentation({
    backgroundTask,
    runtime: sessionRuntime,
    taskState: sessionStates[session.id],
    messageCount: session.messageCount,
    turnCount: session.turnCount,
    sessionStatus: session.status,
    hasNeedsInput: hasNeedsInputForSession(session.id),
  });
  const isRunning = status.kind === 'live' || status.kind === 'background';
  const attentionDotClass = getAttentionDotClassName(status.kind);
  const latestActivityAt = Math.max(
    session.updatedAt || 0,
    sessionRuntime?.lastActivityAt || 0,
    backgroundTask?.backgroundedAt || 0,
  );
  const messageSearchHitGroup = searchQuery.trim() ? messageSearchHitsBySessionId[session.id] : undefined;
  const lastActiveLabel = getRelativeTime(latestActivityAt, true);
  const displayTitle = getDisplaySessionTitle(session.title);
  const canOpenSessionAssets = canReuseSessionWorkbench(session);
  const titleToneClass = isSelected ? 'text-zinc-100' : isUnread ? 'text-zinc-200' : 'text-zinc-400';

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
      role="button"
      tabIndex={0}
      aria-current={isSelected && !multiSelectMode ? 'true' : undefined}
      aria-label={`打开会话 ${displayTitle}`}
      data-session-id={session.id}
      className={`group relative px-3 py-1.5 rounded-lg cursor-pointer transition-colors duration-150 ${isSelected && !multiSelectMode ? 'bg-zinc-700/60' : isChecked ? 'bg-blue-500/10 border border-blue-500/20' : 'hover:bg-zinc-800'}`}
    >
      <div className="flex items-center gap-2">
        {/* 多选 Checkbox */}
        {multiSelectMode && (
          isChecked ? <CheckSquare className="w-4 h-4 text-blue-400 shrink-0" /> : <Square className="w-4 h-4 text-zinc-500 shrink-0" />
        )}

        {/* 置顶 / 未读前导标记 */}
        {isPinned && !multiSelectMode && <Pin className="w-3 h-3 text-amber-500 shrink-0 -rotate-45" />}
        {isUnread && !multiSelectMode && !isPinned && (
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0" aria-label="未读" />
        )}

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
            className={`text-sm truncate flex-1 ${titleToneClass}`}
          >
            {displayTitle}
          </span>
        )}

        {/* 右槽：运行中 spinner / 否则 时间（hover 时淡出给操作让位） */}
        {!isRenaming && (
          <span className="shrink-0 flex items-center gap-1.5 transition-opacity duration-150 group-hover:opacity-0">
            {isRunning ? (
              <Loader2 className="w-3 h-3 text-emerald-400/80 animate-spin" aria-label={status.label} />
            ) : (
              <>
                {attentionDotClass && (
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${attentionDotClass}`} aria-label={status.label} />
                )}
                <span className="text-[11px] text-zinc-600 tabular-nums">{lastActiveLabel}</span>
              </>
            )}
          </span>
        )}
      </div>

      {/* Hover 动作簇：Replay（管理员）/ 产物 / 归档 — 默认隐藏，覆盖右槽位置 */}
      {!multiSelectMode && !isRenaming && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
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
              className="shrink-0 rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          )}
          {canOpenSessionAssets && (
            <button
              type="button"
              aria-label={`打开 ${displayTitle} 的产物与资产`}
              title={`打开 ${displayTitle} 的产物与资产`}
              onClick={(event) => {
                void handleOpenSessionAssets(event, session);
              }}
              className="shrink-0 rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-700/70 hover:text-zinc-200 focus:outline-hidden"
            >
              <ScrollText className="h-3.5 w-3.5" />
            </button>
          )}
          <IconButton
            icon={session.isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
            aria-label={session.isArchived ? 'Unarchive session' : 'Archive session'}
            onClick={(e) => handleArchiveSession(session.id, !!session.isArchived, e)}
            variant="ghost"
            size="sm"
            className="!p-1"
            title={session.isArchived ? '取消归档' : '归档'}
          />
        </div>
      )}

      {/* 搜索命中列表（仅搜索态展开） */}
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
