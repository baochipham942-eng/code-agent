import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Lock, MoreHorizontal } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useI18n } from '../../hooks/useI18n';
import { useLiveAgentPointer } from '../../hooks/useLiveAgentPointer';
import { useSurfaceLiveFrames } from '../../hooks/useSurfaceLiveFrames';
import { useWorkbenchBrowserSession } from '../../hooks/useWorkbenchBrowserSession';
import { useSessionStore } from '../../stores/sessionStore';
import { Button, GhostButton, IconButton } from '../primitives';
import { AgentPointerOverlay } from './AgentPointerOverlay';

// B1-R·R1：workbench「浏览器」tab = **一扇浏览器**，不是状态卡片堆。
// 一条细 chrome（状态点 + 标题 + URL + ⋯）压顶，剩下全给实时画面；指针叠加直接画
// 在画面上。profile 导入 / 扩展目录 / relay 启停 / 清 cookie 等高级管理仍只在 LocalOps，
// 从 ⋯ 深链过去。

type Copy = ReturnType<typeof useI18n>['t']['workbenchTabs']['agentWindow'];

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
            leftIcon={<ExternalLink />}
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
  const { t } = useI18n();
  const copy = t.workbenchTabs.agentWindow;
  const browserSession = useWorkbenchBrowserSession();
  const livePointer = useLiveAgentPointer('browser');
  const openLocalOpsPanel = useAppStore((state) => state.openLocalOpsPanel);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  // 节流护栏的「可见」判据取自 store，不靠「组件挂载了就等于看得见」——右栏收起时
  // 视图仍可能挂着，那种情况下开流就是后台无人看还在烧 CPU。
  const activeWorkbenchTab = useAppStore((state) => state.activeWorkbenchTab);
  const workbenchCollapsed = useAppStore((state) => state.workbenchCollapsed);

  const openAdvancedPanel = useCallback(() => openLocalOpsPanel('browser'), [openLocalOpsPanel]);

  const { managedSession, preview, ownedByCurrentSession, browserSurfaceSessionId } = browserSession;
  const running = managedSession.running;
  const activeTitle = preview?.title || managedSession.activeTab?.title || null;
  const activeUrl = preview?.url || managedSession.activeTab?.url || null;
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
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/[0.06] px-2 py-0.5 text-[10px] text-amber-200"
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
              <div className="text-[11px] leading-relaxed text-red-300">
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
