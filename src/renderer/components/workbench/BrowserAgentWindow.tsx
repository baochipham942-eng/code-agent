import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Lock, MoreHorizontal } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useI18n } from '../../hooks/useI18n';
import { useLiveAgentPointer } from '../../hooks/useLiveAgentPointer';
import { useSurfaceLiveFrames } from '../../hooks/useSurfaceLiveFrames';
import { useWorkbenchBrowserSession } from '../../hooks/useWorkbenchBrowserSession';
import { getPersistedSurfaceTerminalFrame } from '../../services/surfaceExecutionClient';
import { useSessionStore } from '../../stores/sessionStore';
import {
  selectSurfaceExecutionRunSessionV1,
  useSurfaceExecutionStore,
} from '../../stores/surfaceExecutionStore';
import { surfaceExecutionScopeKeyV1 } from '../../utils/surfaceExecutionProjection';
import {
  formatSurfaceExecutionCopy,
  getSurfaceExecutionTranslations,
} from '../../i18n/surfaceExecution';
import type { SurfaceExecutionTranslationsV1 } from '../../i18n/surfaceExecution';
import { Button, GhostButton, IconButton } from '../primitives';
import { AgentPointerOverlay } from './AgentPointerOverlay';
import { closeUserBrowserLinkRun } from '../../services/userBrowserLink';

// B1-R·R1：workbench「浏览器」tab = **一扇浏览器**，不是状态卡片堆。
// 一条细 chrome（状态点 + 标题 + URL + ⋯）压顶，剩下全给实时画面；指针叠加直接画
// 在画面上。profile 导入 / 扩展目录 / relay 启停 / 清 cookie 等高级管理仍只在 LocalOps，
// 从 ⋯ 深链过去。

type Copy = ReturnType<typeof useI18n>['t']['workbenchTabs']['agentWindow'];

/** 摘要卡用时：startedAt → projection updatedAt（裁定用 updatedAt，cleanup completedAt 依赖事件到达） */
function formatTerminalDuration(
  startedAt: number,
  updatedAt: number,
  copy: SurfaceExecutionTranslationsV1['terminal'],
): string {
  const seconds = Math.max(0, Math.round((updatedAt - startedAt) / 1000));
  if (seconds < 60) return formatSurfaceExecutionCopy(copy.durationSeconds, { count: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatSurfaceExecutionCopy(copy.durationMinutes, { count: minutes });
  return formatSurfaceExecutionCopy(copy.durationHours, { count: Math.round(minutes / 60) });
}

const OverflowMenu: React.FC<{ copy: Copy; modeLabel: string; onOpenLocalOps: () => void }> = ({
  copy,
  modeLabel,
  onOpenLocalOps,
}) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <IconButton
        icon={<MoreHorizontal className="h-3.5 w-3.5" />}
        aria-label={copy.moreActions}
        variant="ghost"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        data-testid="browser-agent-window-more"
      />
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-52 rounded-lg border border-white/[0.1] bg-zinc-900/95 p-1 shadow-xl backdrop-blur">
          <div className="px-2 py-1.5 text-[10px] text-zinc-500">{modeLabel}</div>
          <GhostButton
            size="sm"
            className="w-full justify-start"
            leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
            onClick={() => {
              setOpen(false);
              onOpenLocalOps();
            }}
            data-testid="browser-agent-window-open-local-ops"
          >
            {copy.openLocalOps}
          </GhostButton>
        </div>
      )}
    </div>
  );
};

export const BrowserAgentWindow: React.FC = () => {
  const { t, language } = useI18n();
  const copy = t.workbenchTabs.agentWindow;
  const surfaceCopy = getSurfaceExecutionTranslations(language);
  const browserSession = useWorkbenchBrowserSession();
  const livePointer = useLiveAgentPointer('browser');
  const openLocalOpsPanel = useAppStore((state) => state.openLocalOpsPanel);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  // 节流护栏的「可见」判据取自 store，不靠「组件挂载了就等于看得见」——右栏收起时
  // 视图仍可能挂着，那种情况下开流就是后台无人看还在烧 CPU。
  const activeWorkbenchTab = useAppStore((state) => state.activeWorkbenchTab);
  const workbenchCollapsed = useAppStore((state) => state.workbenchCollapsed);

  useEffect(() => {
    if (workbenchCollapsed && currentSessionId) {
      void closeUserBrowserLinkRun(currentSessionId, 'user');
    }
  }, [currentSessionId, workbenchCollapsed]);

  const openAdvancedPanel = useCallback(() => openLocalOpsPanel('browser'), [openLocalOpsPanel]);

  const {
    managedSession, preview, ownedByCurrentSession,
    browserSurfaceSessionId, browserSurfaceTitle, browserSurfaceOrigin,
  } = browserSession;
  // 终态留影：展示层改用**含终态**的选择器拿会话（开流入参仍是上面排除终态的那个，
  // 护栏不动）。只在「没有活跃 browser 会话 且 选中的是终态 browser 会话」时进留影/摘要卡。
  const displaySurfaceSession = useSurfaceExecutionStore((state) => (
    selectSurfaceExecutionRunSessionV1(state.sessionsByScope, { conversationId: currentSessionId })
  ));
  const terminalSurfaceSession = !browserSurfaceSessionId
    && displaySurfaceSession?.session.surface === 'browser'
    && (displaySurfaceSession.session.state === 'completed'
      || displaySurfaceSession.session.state === 'failed')
    ? displaySurfaceSession
    : null;
  const terminalScopeKey = terminalSurfaceSession
    ? surfaceExecutionScopeKeyV1(terminalSurfaceSession.scope)
    : null;
  // 留影帧按 scope 键取——别的会话/别的 run 的帧隔离在别的键下，不会串现场。
  const terminalFrameDataUrl = useSurfaceExecutionStore((state) => (
    terminalScopeKey ? state.frameByScope[terminalScopeKey]?.dataUrl ?? null : null
  ));
  const terminalTarget = terminalSurfaceSession?.session.activeTarget;
  const terminalBrowserTarget = terminalTarget?.kind === 'browser' ? terminalTarget : null;
  // chrome 条必须描述**画面里那扇窗**。有 surface 会话时它才是画面的来源，
  // managedSession 说的是另一个（全局单例）浏览器，直接用会周期性跳回「未启动」。
  const managedUrl = preview?.url || managedSession.activeTab?.url || null;
  const running = Boolean(browserSurfaceSessionId) || managedSession.running;
  const activeTitle = browserSurfaceSessionId
    ? browserSurfaceTitle
    : terminalSurfaceSession
      ? terminalBrowserTarget?.title ?? null
      : preview?.title || managedSession.activeTab?.title || null;
  // surface 会话只报 origin（不含 path）。同源时才敢把 managedSession 的完整 URL 拿来
  // 补全路径——不同源说明那是另一扇窗的地址，宁可只显示 origin 也不能显示错的。
  // 终态会话同样只有 origin，刻意不补 path（reload 后 managedUrl 可能已是别的页面）。
  const activeUrl = browserSurfaceSessionId
    ? (managedUrl && browserSurfaceOrigin && managedUrl.startsWith(browserSurfaceOrigin)
      ? managedUrl
      : browserSurfaceOrigin)
    : terminalSurfaceSession
      ? terminalBrowserTarget?.origin ?? null
      : managedUrl;
  const pointerEvent = livePointer.event || livePointer.lastEvent;
  const modeLabel = browserSession.mode === 'managed'
    ? copy.modeManaged
    : browserSession.mode === 'desktop' ? copy.modeDesktop : copy.modeNone;

  const liveStream = useSurfaceLiveFrames({
    conversationId: currentSessionId,
    surfaceSessionId: browserSurfaceSessionId,
    visible: activeWorkbenchTab === 'browser' && !workbenchCollapsed,
    sessionRunning: Boolean(browserSurfaceSessionId),
  });

  // 重启/刷新后内存 frameByScope 是空的：终态会话还在（host 投影恢复），试着从盘上
  // 把留影帧读回来补进 store（标 'stale'，三态渲染自然落留影）。每个 scope 只试一次，
  // 读不到就保持摘要卡兜底，不重复打 IPC。
  const persistedFrameTriedRef = useRef<Set<string>>(new Set());
  // scope 走 ref 而不是进依赖数组：terminalSurfaceSession 来自内联 selector，每次 store
  // 变动都是**新对象**，进依赖数组会让 effect 每次渲染重跑。配上「每个 scope 只试一次」
  // 的 ref，后果是读回请求发出去了、响应也回来了，却被 cleanup 判成过期丢掉，且永不重试
  // ——真机实测正是这样：HTTP 200 帧完好，屏幕永远停在摘要卡。
  const terminalScopeRef = useRef(terminalSurfaceSession?.scope ?? null);
  terminalScopeRef.current = terminalSurfaceSession?.scope ?? null;
  useEffect(() => {
    const scope = terminalScopeRef.current;
    if (!scope || !terminalScopeKey || terminalFrameDataUrl) return;
    if (persistedFrameTriedRef.current.has(terminalScopeKey)) return;
    persistedFrameTriedRef.current.add(terminalScopeKey);
    void getPersistedSurfaceTerminalFrame({
      version: 1,
      conversationId: scope.conversationId,
      surfaceSessionId: scope.surfaceSessionId,
    })
      .then((result) => {
        // 不设 cancelled 守卫：帧是按 scope 键写进 store 的，即便这时用户已经切走，
        // 写的也只是它自己那把键下的内容，不会串到别的现场；而丢弃它等于永久失去。
        if (!result.frame) return;
        useSurfaceExecutionStore.getState().setFrameState(scope, {
          status: 'stale',
          dataUrl: result.frame.dataUrl,
          updatedAt: Date.now(),
        });
      })
      .catch(() => undefined);
  }, [terminalScopeKey, terminalFrameDataUrl]);

  const [primaryRepair, ...secondaryRepairs] = ownedByCurrentSession
    ? browserSession.repairActions
    : [];

  return (
    <div
      data-testid="workbench-browser-view"
      className="flex h-full min-h-0 flex-col bg-zinc-950"
    >
      <div
        data-testid="browser-agent-window-chrome"
        className="flex shrink-0 items-center gap-2 border-b border-white/[0.08] px-2.5 py-1.5"
      >
        <span
          data-testid="browser-agent-window-status-dot"
          title={running ? copy.running : copy.stopped}
          className={`h-2 w-2 shrink-0 rounded-full ${
            running ? 'bg-emerald-400' : 'bg-zinc-600'
          }`}
        />
        <span className="min-w-0 truncate text-xs text-zinc-300" title={activeTitle || undefined}>
          {activeTitle || copy.activeTabEmpty}
        </span>
        {activeUrl && (
          <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-600" title={activeUrl}>
            {activeUrl}
          </span>
        )}
        {!ownedByCurrentSession && (
          <span
            data-testid="browser-agent-window-foreign"
            title={`${copy.foreignSessionTitle} · ${copy.foreignSessionHint}`}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-badge-warning/20 bg-amber-500/[0.06] px-2 py-0.5 text-[10px] text-badge-warning"
          >
            <Lock className="h-3 w-3" />
            {copy.foreignSessionTitle}
          </span>
        )}
        <div className={ownedByCurrentSession ? 'ml-auto' : ''}>
          <OverflowMenu copy={copy} modeLabel={modeLabel} onOpenLocalOps={openAdvancedPanel} />
        </div>
      </div>

      <div
        data-testid="browser-agent-window-stage"
        className="relative min-h-0 flex-1 overflow-hidden bg-black/40"
      >
        {liveStream.frame ? (
          <img
            data-testid="browser-agent-window-frame"
            src={liveStream.frame.dataUrl}
            alt={copy.livePicture}
            className="h-full w-full object-contain"
          />
        ) : terminalSurfaceSession && terminalFrameDataUrl ? (
          // 终态留影：停流前移交进 store 的最后一帧，置灰 +「已结束」角标。
          <div data-testid="browser-agent-window-terminal" className="relative h-full w-full">
            <img
              data-testid="browser-agent-window-terminal-frame"
              src={terminalFrameDataUrl}
              alt={surfaceCopy.terminal.frameAlt}
              className="h-full w-full object-contain grayscale opacity-60"
            />
            <span
              data-testid="browser-agent-window-ended-badge"
              className="absolute right-2 top-2 rounded-full border border-white/10 bg-zinc-900/80 px-2 py-0.5 text-[10px] text-zinc-300"
            >
              {surfaceCopy.terminal.badge}
            </span>
          </div>
        ) : terminalSurfaceSession ? (
          // 终态无留影帧（如 reload 后）：摘要卡兜底，不回「还没有打开页面」空态谎言。
          <div
            data-testid="browser-agent-window-terminal-summary"
            className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
          >
            <span
              data-testid="browser-agent-window-ended-badge"
              className="rounded-full border border-white/10 bg-zinc-900/80 px-2 py-0.5 text-[10px] text-zinc-300"
            >
              {surfaceCopy.terminal.badge}
              {' · '}
              {surfaceCopy.state[terminalSurfaceSession.session.state]}
            </span>
            <div className="max-w-[320px] truncate text-xs text-zinc-300">
              {terminalBrowserTarget?.title || surfaceCopy.terminal.untitled}
            </div>
            {terminalBrowserTarget?.origin && (
              <div className="max-w-[320px] truncate text-[11px] text-zinc-500">
                {terminalBrowserTarget.origin}
              </div>
            )}
            <div className="text-[11px] text-zinc-600">
              {formatSurfaceExecutionCopy(surfaceCopy.terminal.duration, {
                time: formatTerminalDuration(
                  terminalSurfaceSession.session.startedAt,
                  terminalSurfaceSession.updatedAt,
                  surfaceCopy.terminal,
                ),
              })}
            </div>
          </div>
        ) : (
          <div
            data-testid="browser-agent-window-empty"
            className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
          >
            <div className="text-xs text-zinc-400">
              {primaryRepair
                ? copy.notReadyTitle
                : liveStream.streaming
                  ? copy.connecting
                  : liveStream.unavailableReason
                    ? copy.streamUnavailable
                    : copy.idleTitle}
            </div>
            <div className="max-w-[320px] text-[11px] leading-relaxed text-zinc-600">
              {primaryRepair ? browserSession.blockedDetail || copy.idleHint : copy.idleHint}
            </div>
            {browserSession.actionError && (
              <div className="text-[11px] leading-relaxed text-badge-danger">
                {browserSession.actionError}
              </div>
            )}
            {primaryRepair && (
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                <Button
                  variant="primary"
                  size="sm"
                  loading={browserSession.busyActionKind === primaryRepair.kind}
                  onClick={() => void browserSession.runRepairAction(primaryRepair)}
                  data-testid={`browser-agent-window-repair-${primaryRepair.kind}`}
                >
                  {primaryRepair.label}
                </Button>
                {secondaryRepairs.map((action) => (
                  <GhostButton
                    key={action.kind}
                    size="sm"
                    loading={browserSession.busyActionKind === action.kind}
                    onClick={() => void browserSession.runRepairAction(action)}
                    data-testid={`browser-agent-window-repair-${action.kind}`}
                  >
                    {action.label}
                  </GhostButton>
                ))}
              </div>
            )}
          </div>
        )}
        {pointerEvent && (
          <AgentPointerOverlay event={pointerEvent} live={livePointer.isLive} />
        )}
      </div>
    </div>
  );
};
