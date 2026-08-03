import React from 'react';
import { Archive, ArchiveRestore, AudioLines, CheckSquare, GitFork, Loader2, Pin, Square } from 'lucide-react';
import type { SessionRuntimeSummary } from '@shared/ipc';
import type { SessionAutomationSessionSummary } from '@shared/contract';
import { IconButton } from '../../primitives';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import type { SessionState } from '../../../stores/taskStore';
import { getDisplaySessionTitle, getSessionStatusPresentation } from '../../../utils/sessionPresentation';
import { localeForLanguage } from '../../../utils/i18nTime';
import { useI18n } from '../../../hooks/useI18n';
import { SidebarMessageHitList } from './SidebarMessageHitList';
import type { SidebarDerivedSessions } from './useSidebarDerivedSessions';
import type { SidebarSessionActions } from './useSidebarSessionActions';
import type { SidebarRowActions } from './useSidebarRowActions';
import {
  SurfaceExecutionRunStatus,
  useSurfaceExecutionRunSession,
} from '../surfaceExecution/SurfaceExecutionRunStatus';

/**
 * 需要关注但非运行中的状态，行尾显一个安静的小圆点（不是带文字的彩色 chip），
 * 颜色对齐 sessionPresentation 的语义色。状态点与时间二选一：有状态点时时间让位，
 * 行尾同一时刻只讲一件事。
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

function getForkParentSessionId(session: SessionWithMeta): string | null {
  const lineage = session.metadata?.forkLineage;
  if (lineage && typeof lineage === 'object' && !Array.isArray(lineage)) {
    const parentSessionId = (lineage as Record<string, unknown>).parentSessionId;
    if (typeof parentSessionId === 'string' && parentSessionId.trim()) {
      return parentSessionId;
    }
  }
  return null;
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
  backgroundSessionMap: SidebarDerivedSessions['backgroundSessionMap'];
  sessionStates: Record<string, SessionState>;
  hasNeedsInputForSession: SidebarDerivedSessions['hasNeedsInputForSession'];
  searchQuery: string;
  messageSearchHitsBySessionId: SidebarDerivedSessions['messageSearchHitsBySessionId'];
  replayEvidenceBySessionId: SidebarDerivedSessions['replayEvidenceBySessionId'];
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
  handleOpenReplayEvidence: SidebarRowActions['handleOpenReplayEvidence'];
  handleSelectMessageSearchHit: SidebarSessionActions['handleSelectMessageSearchHit'];
  handleArchiveSession: SidebarSessionActions['handleArchiveSession'];
}

/** SidebarSessionItem 除 `session` 外的共享 props，供 SidebarProjectGroup 按会话批量透传。 */
export type SidebarSessionItemSharedProps = Omit<SidebarSessionItemProps, 'session'>;

/**
 * 单条会话行（Codex 风极简版）：默认只显「标题 + 右侧时间」，运行中显 spinner，
 * 需关注状态显一个安静小圆点；hover 只浮现归档（2026-07-29：Replay/产物图标已撤，
 * 入口保留在右键菜单与项目 ⋯ 菜单）。
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
  backgroundSessionMap,
  sessionStates,
  hasNeedsInputForSession,
  searchQuery,
  messageSearchHitsBySessionId,
  multiSelectMode,
  renameValue,
  renameInputRef,
  setRenameValue,
  handleSelectSession,
  handleContextMenu,
  handleRenameSubmit,
  handleRenameKeyDown,
  handleDoubleClick,
  handleSelectMessageSearchHit,
  handleArchiveSession,
}) => {
  const { t, language } = useI18n();
  const s = t.sidebarSession;
  const isUnread = unreadSessionIds.has(session.id);
  const isSelected = currentSessionId === session.id;
  const isChecked = selectedSessionIds.has(session.id);
  const isPinned = pinnedSessionIds.has(session.id);
  const isRenaming = renamingId === session.id;
  const sessionRuntime = sessionRuntimes.get(session.id);
  const backgroundSession = backgroundSessionMap.get(session.id);
  const surfaceExecutionSession = useSurfaceExecutionRunSession(session.id);
  const status = getSessionStatusPresentation({
    backgroundSession,
    runtime: sessionRuntime,
    taskState: sessionStates[session.id],
    messageCount: session.messageCount,
    turnCount: session.turnCount,
    sessionStatus: session.status,
    hasNeedsInput: hasNeedsInputForSession(session.id),
  });
  const localizedStatusLabel =
    status.kind === 'error' ? t.common.error : status.kind === 'incomplete' ? t.common.incomplete : status.label;
  const isRunning = status.kind === 'live' || status.kind === 'background';
  const attentionDotClass = getAttentionDotClassName(status.kind);
  const latestActivityAt = Math.max(
    session.updatedAt || 0,
    sessionRuntime?.lastActivityAt || 0,
    backgroundSession?.backgroundedAt || 0,
  );
  const messageSearchHitGroup = searchQuery.trim() ? messageSearchHitsBySessionId[session.id] : undefined;
  const displayTitle = getDisplaySessionTitle(session.title);
  // 这条会话用过实时语音（host 在建连时写进会话 metadata）。是身份不是状态，
  // 所以走行尾的身份轴（右槽），不进讲「此刻怎么了」的状态槽——详见下方渲染处。
  const hadLiveVoice = session.metadata?.hadLiveVoice === true;
  const titleToneClass = isSelected ? 'text-zinc-100' : isUnread ? 'text-zinc-200' : 'text-zinc-400';
  const forkParentSessionId = getForkParentSessionId(session);

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
      aria-label={s.openSession.replace('{title}', displayTitle)}
      data-session-id={session.id}
      title={new Date(latestActivityAt).toLocaleString(localeForLanguage(language))}
      className={`group relative pl-0 pr-1.5 py-1.5 rounded-lg cursor-pointer transition-colors duration-150 ${isSelected && !multiSelectMode ? 'bg-zinc-700/60' : isChecked ? 'bg-blue-500/10 border border-blue-500/20' : 'hover:bg-zinc-800'}`}
    >
      <div className="flex items-center gap-2">
        {/* 多选 Checkbox */}
        {multiSelectMode && (
          isChecked ? <CheckSquare className="w-4 h-4 text-blue-400 shrink-0" /> : <Square className="w-4 h-4 text-zinc-500 shrink-0" />
        )}

        {/* 前导槽：宽度恒定 16px，有没有置顶标记标题左缘都不动
            （此前置顶 12px / 未读 6px / 无标记 0px 三档，标题左缘跟着漂移）。
            未读点已挪到行尾状态列。 */}
        {!multiSelectMode && (
          <span className="w-4 shrink-0 flex items-center justify-center">
            {isPinned && <Pin className="w-3 h-3 text-badge-warning -rotate-45" />}
          </span>
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
            className={`min-w-0 flex-1 truncate text-sm ${titleToneClass}`}
          >
            {displayTitle}
          </span>
        )}

        {/* 行尾状态轴：**一个**固定 16px 槽，内容按优先级互斥 ——
            临时状态 > 分叉标记 > 用过实时语音。
            · 状态压身份（2026-07-28 产品负责人拍板，推翻「两槽并存、身份占最右轴」）：
              分叉/语音这类身份标记绝大多数会话都没有，让身份单独占最右轴 ⇒ 那一格常年空着，
              肉眼看到的最右元素变成状态点，落在 190.8 而不是全栏右轨 214.8，
              与分组角标 / 账号箭头错开 24（= 16 槽 + 8 gap，实测截图）。
            · 身份内部分叉压语音（#756 定的次序，保留）：两者都在说这会话**是什么**，
              但分叉标记可点击、能跳回父会话，信息量更大。
            代价说清楚：分叉/语音会话正在运行或需关注时，这一刻只显示状态，身份标记等状态清了再回来。
            分叉标记点击跳回父会话；hover 动作簇上来时本槽让位。 */}
        {!isRenaming && (
          <span className="w-4 shrink-0 flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0">
            {surfaceExecutionSession ? (
              <SurfaceExecutionRunStatus session={surfaceExecutionSession} />
            ) : isRunning ? (
              <Loader2 className="w-3 h-3 text-badge-success/80 animate-spin" aria-label={localizedStatusLabel} />
            ) : attentionDotClass ? (
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${attentionDotClass}`} aria-label={localizedStatusLabel} />
            ) : isUnread && !multiSelectMode ? (
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0" aria-label={s.unread} />
            ) : forkParentSessionId && !multiSelectMode ? (
              <button /* ds-allow:button: 侧栏最右状态轴上的分叉身份小图标，Button primitive 动作按钮形状不适配列表行 */
                type="button"
                data-testid="fork-lineage-marker"
                aria-label={s.forkedFrom.replace('{sessionId}', forkParentSessionId)}
                title={s.openForkParent.replace('{sessionId}', forkParentSessionId)}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleSelectSession(forkParentSessionId);
                }}
                className="shrink-0 rounded p-0.5 text-badge-accent transition-colors hover:bg-violet-500/15 hover:text-badge-accent focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-violet-400"
              >
                <GitFork className="h-3.5 w-3.5" />
              </button>
            ) : hadLiveVoice ? (
              <AudioLines
                className="h-3.5 w-3.5 shrink-0 text-zinc-500"
                aria-label={s.liveVoiceSession}
                data-testid="session-live-voice-badge"
              />
            ) : null}
          </span>
        )}
      </div>

      {/* Hover 动作簇：只留归档（2026-07-29 侧栏项目区 redesign，对齐 Codex 极简行）。
          Replay / 产物入口仍在右键菜单与项目 ⋯ 菜单，不删功能只删行内图标。
          显隐用 group-focus-visible 而非 group-focus-within（2026-07-26 打磨批 D D3）：
          鼠标点击按钮后 Chrome 会留下 :focus（但不标 :focus-visible），focus-within
          因此粘滞——鼠标移开后动作簇仍常驻；键盘 Tab 聚焦照样命中 focus-visible，
          可及性不受损。
          对齐返工二（2026-08-02 真侧栏 Chromium 几何）：状态点/徽章圆心距行右缘 14px；
          归档 svg 圆心距动作簇右缘 11px（IconButton p-1 + 14px 图标半径）。
          所以簇右侧留 3px，3 + 11 = 14，让图标圆心与状态轴心对心；
          top-1/2 + -translate-y-1/2 独立保证图标继续沿行内竖向居中。 */}
      {!multiSelectMode && !isRenaming && (
        <div className="absolute right-[3px] top-1/2 -translate-y-1/2 z-10 flex items-center gap-0.5 rounded-md bg-zinc-800 pl-2 shadow-[-8px_0_8px_-4px_rgba(24,24,27,0.95)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
          <IconButton
            icon={session.isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
            aria-label={`${session.isArchived ? s.unarchiveSession : s.archiveSession} ${displayTitle}`}
            onClick={(e) => handleArchiveSession(session.id, !!session.isArchived, e)}
            variant="ghost"
            size="sm"
            title={session.isArchived ? s.unarchive : s.archive}
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
