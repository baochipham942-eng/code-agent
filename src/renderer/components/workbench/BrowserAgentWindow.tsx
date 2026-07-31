import React, { useCallback } from 'react';
import { ExternalLink, Globe, Lock } from 'lucide-react';
import type { BrowserSessionMode } from '@shared/contract/conversationEnvelope';
import { useAppStore } from '../../stores/appStore';
import { useI18n } from '../../hooks/useI18n';
import { useLiveAgentPointer } from '../../hooks/useLiveAgentPointer';
import { useWorkbenchBrowserSession } from '../../hooks/useWorkbenchBrowserSession';
import { Button, GhostButton } from '../primitives';
import { AgentPointerPreviewCard, AgentPointerTimelineList } from './AgentPointerOverlay';

// workbench「浏览器」tab = Agent 正在操作的那扇窗（现场），不是设置页。
// profile 导入 / 扩展目录 / relay 启停 / 清 cookie 等高级管理全部留在 LocalOps
// 的浏览器 tab（BrowserSurfaceContent），这里只给深链入口。

type Copy = ReturnType<typeof useI18n>['t']['browserAgentWindow'];

function getModeLabel(mode: BrowserSessionMode, copy: Copy): string {
  if (mode === 'managed') return copy.modeManaged;
  if (mode === 'desktop') return copy.modeDesktop;
  return copy.modeNone;
}

export const BrowserAgentWindow: React.FC = () => {
  const { t } = useI18n();
  const copy = t.browserAgentWindow;
  const browserSession = useWorkbenchBrowserSession();
  const livePointer = useLiveAgentPointer('browser');
  const openLocalOpsPanel = useAppStore((state) => state.openLocalOpsPanel);

  const openAdvancedPanel = useCallback(() => openLocalOpsPanel('browser'), [openLocalOpsPanel]);

  const { managedSession, preview, ownedByCurrentSession } = browserSession;
  const running = managedSession.running;
  const activeTitle = preview?.title || managedSession.activeTab?.title || null;
  const activeUrl = preview?.url || managedSession.activeTab?.url || null;
  const pointerEvent = livePointer.event || livePointer.lastEvent;

  return (
    <div
      data-testid="workbench-browser-view"
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3"
    >
      <div
        data-testid="browser-agent-window-status"
        className="rounded-lg border border-white/[0.08] bg-zinc-950/50 px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 shrink-0 text-sky-400/80" />
          <span className="min-w-0 truncate text-xs text-zinc-300">
            {getModeLabel(browserSession.mode, copy)}
          </span>
          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${
            running
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
              : 'border-white/[0.08] bg-zinc-900/60 text-zinc-500'
          }`}>
            {running ? copy.running : copy.stopped}
          </span>
          {running && (
            <span className="shrink-0 text-[10px] text-zinc-500">
              {copy.tabCount.replace('{count}', String(managedSession.tabCount))}
            </span>
          )}
          <GhostButton
            size="sm"
            className="ml-auto shrink-0"
            leftIcon={<ExternalLink />}
            onClick={openAdvancedPanel}
            data-testid="browser-agent-window-open-local-ops"
          >
            {copy.openLocalOps}
          </GhostButton>
        </div>
        <div className="mt-1 min-w-0">
          {activeTitle || activeUrl ? (
            <>
              <div className="truncate text-xs text-zinc-400" title={activeTitle || undefined}>
                {activeTitle || activeUrl}
              </div>
              {activeUrl && (
                <div className="truncate text-[10px] text-zinc-600" title={activeUrl}>
                  {activeUrl}
                </div>
              )}
            </>
          ) : (
            <div className="text-[10px] text-zinc-600">{copy.activeTabEmpty}</div>
          )}
        </div>
      </div>

      {!ownedByCurrentSession && (
        <div
          data-testid="browser-agent-window-foreign"
          className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2"
        >
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300/80" />
          <div className="min-w-0">
            <div className="text-xs text-amber-200">{copy.foreignSessionTitle}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
              {copy.foreignSessionHint}
            </div>
          </div>
        </div>
      )}

      {pointerEvent ? (
        <AgentPointerPreviewCard
          event={pointerEvent}
          title={copy.liveTitle}
          detail={livePointer.isLive ? undefined : copy.liveDetailIdle}
          live={livePointer.isLive}
        />
      ) : (
        <div
          data-testid="browser-agent-window-idle"
          className="rounded-lg border border-white/[0.08] bg-zinc-950/40 px-3 py-6 text-center"
        >
          <div className="text-xs text-zinc-400">{copy.idleTitle}</div>
          <div className="mx-auto mt-1 max-w-[320px] text-[11px] leading-relaxed text-zinc-600">
            {copy.idleHint}
          </div>
        </div>
      )}

      <AgentPointerTimelineList entries={livePointer.timeline} title={copy.timelineTitle} />

      {browserSession.repairActions.length > 0 && ownedByCurrentSession && (
        <div
          data-testid="browser-agent-window-repair"
          className="rounded-lg border border-white/[0.08] bg-zinc-950/40 px-3 py-2"
        >
          <div className="text-[11px] text-zinc-400">{copy.notReadyTitle}</div>
          {browserSession.blockedDetail && (
            <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              {browserSession.blockedDetail}
            </div>
          )}
          {browserSession.actionError && (
            <div className="mt-1 text-[11px] leading-relaxed text-red-300">
              {browserSession.actionError}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {browserSession.repairActions.map((action) => (
              <Button
                key={action.kind}
                variant="secondary"
                size="sm"
                loading={browserSession.busyActionKind === action.kind}
                onClick={() => void browserSession.runRepairAction(action)}
                data-testid={`browser-agent-window-repair-${action.kind}`}
              >
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
