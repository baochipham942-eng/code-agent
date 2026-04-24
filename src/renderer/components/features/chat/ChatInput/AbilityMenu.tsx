// ============================================================================
// AbilityMenu — ChatInput 工具栏里的能力 popover：Routing + Browser
// ============================================================================
//
// 把原来挂在 InlineWorkbenchBar 上的 Routing 三 pill 和 Browser 三 pill 收到这个
// popover 里。点击触发按钮展开；外部点击 / ESC 关闭。
//
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Eye, GitBranch, Globe, Info, Loader2, Monitor } from 'lucide-react';
import type { BrowserSessionMode, ConversationRoutingMode } from '@shared/contract/conversationEnvelope';
import { useComposerStore } from '../../../../stores/composerStore';
import type { BrowserWorkbenchRepairAction, BrowserWorkbenchState } from '../../../../hooks/useWorkbenchBrowserSession';
import {
  buildBrowserWorkbenchStatusRows,
  getBrowserWorkbenchOperationalHint,
  getBrowserWorkbenchReadinessTone,
  type BrowserWorkbenchStatusTone,
} from '../../../../utils/workbenchPresentation';

const ROUTING_LABELS: Record<ConversationRoutingMode, string> = {
  auto: 'Auto',
  direct: 'Direct',
  parallel: 'Parallel',
};

const BROWSER_LABELS: Record<BrowserSessionMode, string> = {
  none: 'Off',
  managed: 'Managed',
  desktop: 'Desktop',
};

interface AbilityMenuProps {
  disabled?: boolean;
  defaultOpen?: boolean;
  browserSession?: Pick<
    BrowserWorkbenchState,
    | 'managedSession'
    | 'computerSurface'
    | 'preview'
    | 'readinessItems'
    | 'blocked'
    | 'blockedDetail'
    | 'blockedHint'
    | 'repairActions'
    | 'busyActionKind'
    | 'actionError'
  > & {
    runRepairAction: (action: BrowserWorkbenchRepairAction) => Promise<void>;
  };
}

function getStatusToneClasses(tone?: BrowserWorkbenchStatusTone): string {
  switch (tone) {
    case 'ready':
      return 'text-emerald-300';
    case 'blocked':
      return 'text-amber-300';
    default:
      return 'text-zinc-300';
  }
}

export const AbilityMenu: React.FC<AbilityMenuProps> = ({ disabled = false, defaultOpen = false, browserSession }) => {
  const routingMode = useComposerStore((state) => state.routingMode);
  const setRoutingMode = useComposerStore((state) => state.setRoutingMode);
  const browserSessionMode = useComposerStore((state) => state.browserSessionMode);
  const setBrowserSessionMode = useComposerStore((state) => state.setBrowserSessionMode);

  const [open, setOpen] = useState(defaultOpen);
  const [livePreviewUrl, setLivePreviewUrl] = useState('http://localhost:5175/');
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const handleOpenLivePreview = useCallback(() => {
    const url = livePreviewUrl.trim();
    if (!url) return;
    // 复用 index.tsx 挂载的全局入口 — 走 validateDevServerUrl IPC 校验链路
    void window.__openLivePreview?.(url);
    setOpen(false);
  }, [livePreviewUrl]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const summary = useCallback(() => {
    const parts: string[] = [];
    if (routingMode !== 'auto') parts.push(ROUTING_LABELS[routingMode]);
    if (browserSessionMode !== 'none') parts.push(BROWSER_LABELS[browserSessionMode]);
    return parts.length === 0 ? '能力' : parts.join(' · ');
  }, [browserSessionMode, routingMode]);

  const hasActive = routingMode !== 'auto' || browserSessionMode !== 'none';
  const browserStatusRows = useMemo(
    () => buildBrowserWorkbenchStatusRows({
      mode: browserSessionMode,
      browserSession,
    }),
    [browserSession, browserSessionMode],
  );
  const browserOperationalHint = useMemo(
    () => getBrowserWorkbenchOperationalHint({
      mode: browserSessionMode,
      browserSession,
    }),
    [browserSession, browserSessionMode],
  );

  return (
    <div ref={wrapperRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        data-testid="ability-menu-trigger"
        className={`inline-flex items-center gap-1 h-8 rounded-lg px-2 text-xs transition-colors ${
          hasActive
            ? 'bg-primary-500/15 text-primary-200 hover:bg-primary-500/20'
            : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        aria-label="能力"
        title="Routing / Browser 配置"
      >
        <GitBranch className="w-3.5 h-3.5" />
        <span className="max-w-[140px] truncate">{summary()}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          data-testid="ability-menu-popover"
          className="absolute bottom-full left-0 mb-2 w-64 rounded-lg border border-white/[0.1] bg-zinc-900/95 p-3 shadow-xl backdrop-blur z-30"
        >
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <GitBranch className="w-3 h-3" />
            Routing
          </div>
          <div className="mb-3 grid grid-cols-3 gap-1">
            {(['auto', 'direct', 'parallel'] as ConversationRoutingMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setRoutingMode(mode)}
                data-testid={`ability-menu-routing-${mode}`}
                className={`rounded-md px-2 py-1.5 text-xs transition-colors ${
                  routingMode === mode
                    ? 'bg-primary-500/20 text-primary-200'
                    : 'bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
                }`}
              >
                {ROUTING_LABELS[mode]}
              </button>
            ))}
          </div>

          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <Globe className="w-3 h-3" />
            Browser
          </div>
          <div className="grid grid-cols-3 gap-1">
            {(['none', 'managed', 'desktop'] as BrowserSessionMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setBrowserSessionMode(mode)}
                data-testid={`ability-menu-browser-${mode}`}
                className={`rounded-md px-2 py-1.5 text-xs transition-colors ${
                  browserSessionMode === mode
                    ? 'bg-primary-500/20 text-primary-200'
                    : 'bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
                }`}
              >
                {BROWSER_LABELS[mode]}
              </button>
            ))}
          </div>
          <div className="mt-3 mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <Eye className="w-3 h-3" />
            Live Preview
          </div>
          <div className="flex gap-1">
            <input
              type="url"
              value={livePreviewUrl}
              onChange={(e) => setLivePreviewUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleOpenLivePreview();
                }
              }}
              placeholder="http://localhost:5175/"
              data-testid="ability-menu-live-preview-url"
              className="flex-1 min-w-0 rounded-md bg-white/[0.03] px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 outline-none focus:bg-white/[0.06]"
            />
            <button
              type="button"
              onClick={handleOpenLivePreview}
              data-testid="ability-menu-live-preview-open"
              className="flex-shrink-0 rounded-md bg-primary-500/15 px-3 py-1.5 text-xs text-primary-200 transition-colors hover:bg-primary-500/25"
            >
              Open
            </button>
          </div>

          {browserSession && browserSessionMode !== 'none' && (
            <div
              data-testid="ability-menu-browser-status"
              className="mt-2 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-2 text-[11px] text-zinc-400"
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-zinc-300">
                  <Monitor className="h-3 w-3" />
                  <span>{browserSessionMode === 'managed' ? 'Managed browser' : 'Computer surface'}</span>
                </div>
                <span className={browserSession.blocked ? 'text-amber-300' : 'text-emerald-300'}>
                  {browserSession.blocked ? 'Blocked' : 'Ready'}
                </span>
              </div>

              {browserStatusRows.length > 0 && (
                <div className="space-y-1">
                  {browserStatusRows.map((row) => (
                    <div
                      key={row.label}
                      data-testid={`ability-menu-status-row-${row.label.toLowerCase()}`}
                      className="grid grid-cols-[52px,minmax(0,1fr)] gap-2"
                    >
                      <span className="text-zinc-500">{row.label}</span>
                      <span
                        className={`truncate ${getStatusToneClasses(row.tone)}`}
                        title={row.title || row.value}
                      >
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {browserSessionMode === 'desktop' && browserSession.readinessItems.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-white/[0.06] pt-2">
                  {browserSession.readinessItems.map((item) => {
                    const tone = getBrowserWorkbenchReadinessTone(item);
                    return (
                      <div
                        key={item.key}
                        data-testid={`ability-menu-readiness-${item.key}`}
                        className="flex items-center justify-between gap-2"
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          {tone === 'ready' ? (
                            <CheckCircle2 className="h-3 w-3 flex-shrink-0 text-emerald-300" />
                          ) : tone === 'blocked' ? (
                            <AlertTriangle className="h-3 w-3 flex-shrink-0 text-amber-300" />
                          ) : (
                            <Info className="h-3 w-3 flex-shrink-0 text-zinc-500" />
                          )}
                          <span className="truncate text-zinc-400" title={item.detail || item.label}>
                            {item.label}
                          </span>
                        </div>
                        <span className={`flex-shrink-0 ${getStatusToneClasses(tone)}`}>{item.value}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {browserOperationalHint && (
                <div className={`mt-2 leading-relaxed ${browserSession.blocked ? 'text-amber-300' : 'text-zinc-500'}`}>
                  {browserOperationalHint}
                </div>
              )}
              {browserSession.blocked && browserSession.blockedHint && (
                <div className="mt-1 leading-relaxed text-zinc-500">{browserSession.blockedHint}</div>
              )}
              {browserSession.actionError && (
                <div className="mt-1 leading-relaxed text-red-300">{browserSession.actionError}</div>
              )}

              {browserSession.repairActions.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2">
                  {browserSession.repairActions.map((action) => {
                    const loading = browserSession.busyActionKind === action.kind;
                    return (
                      <button
                        key={action.kind}
                        type="button"
                        onClick={() => void browserSession.runRepairAction(action)}
                        disabled={loading}
                        data-testid={`ability-menu-repair-${action.kind}`}
                        className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-white/[0.16] hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                        <span>{action.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AbilityMenu;
