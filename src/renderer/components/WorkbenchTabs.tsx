// ============================================================================
// WorkbenchTabs - Unified tab bar for the right workbench panel
// ============================================================================
// Mixes fixed workbench views with per-file preview tabs. Click to
// activate, X or middle-click to close. Dirty indicator shown on preview tabs.

import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, LayoutDashboard, FolderTree, Globe2, Palette } from 'lucide-react';
import { useAppStore, type WorkbenchViewId } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useI18n } from '../hooks/useI18n';
import { useDesignCanvasStore } from './design/designCanvasStore';
import { saveCanvasDoc } from './design/designCanvasPersistence';
import { ConfirmDialog } from './composites/ConfirmDialog';

const PREVIEW_PREFIX = 'preview:';

function getFileName(path: string): string {
  const last = path.split('/').pop();
  return last && last.length > 0 ? last : path;
}

interface TabMeta {
  id: WorkbenchViewId;
  label: string;
  title: string; // tooltip
  isDirty: boolean;
}

export const WorkbenchTabs: React.FC = () => {
  const { t } = useI18n();
  const workbenchTabs = useAppStore((s) => s.workbenchTabs);
  const activeWorkbenchTab = useAppStore((s) => s.activeWorkbenchTab);
  const previewTabs = useAppStore((s) => s.previewTabs);
  const closeWorkbenchTab = useAppStore((s) => s.closeWorkbenchTab);
  const openWorkbenchTab = useAppStore((s) => s.openWorkbenchTab);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);

  // "+" 按钮的 popover 状态：列出未打开的固定视图让用户重开
  const [addOpen, setAddOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState<TabMeta | null>(null);
  const addRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<WorkbenchViewId, HTMLButtonElement>());
  useEffect(() => {
    if (!addOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!addRef.current?.contains(e.target as Node)) setAddOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAddOpen(false); };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen]);

  // 已开 tab 永远要显示；空 workbench 时也要保留 "+" 让用户能开第一个。
  const hasOverview = workbenchTabs.includes('overview');
  const hasFiles = workbenchTabs.includes('files');
  const hasBrowser = workbenchTabs.includes('browser');
  const canAddAny = !hasOverview || !hasFiles || !hasBrowser;

  const metas: TabMeta[] = workbenchTabs.map((id) => {
    if (id === 'overview') {
      return {
        id,
        label: t.workbenchTabs.overviewLabel,
        title: t.workbenchTabs.overviewTitle,
        isDirty: false,
      };
    }
    if (id === 'files') {
      return { id, label: t.workbenchTabs.filesLabel, title: t.workbenchTabs.filesTitle, isDirty: false };
    }
    if (id === 'browser') {
      return {
        id,
        label: t.workbenchTabs.browserLabel,
        title: t.workbenchTabs.browserTitle,
        isDirty: false,
      };
    }
    if (id === 'design-canvas') {
      return { id, label: t.design.canvasTabLabel, title: t.design.canvasTabLabel, isDirty: false };
    }
    const path = id.slice(PREVIEW_PREFIX.length);
    const previewTab = previewTabs.find((p) => p.path === path);
    const isDirty = previewTab ? previewTab.content !== previewTab.savedContent : false;
    return { id, label: getFileName(path), title: path, isDirty };
  });

  const requestClose = (meta: TabMeta) => {
    if (meta.isDirty) {
      setPendingClose(meta);
      return;
    }
    closeWorkbenchTab(meta.id);
  };

  return (
    <>
    <div className="flex items-center px-2 py-1 border-b border-zinc-700 bg-zinc-900">
      {/* tabs 自己滚动；[+] 不在滚动区里，popover 才能 escape overflow 弹出来 */}
      <div role="tablist" className="flex items-center gap-0.5 overflow-x-auto scrollbar-none flex-1 min-w-0">
      {metas.map((meta) => {
        const isActive = meta.id === activeWorkbenchTab;
        return (
          <div
            key={meta.id}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                requestClose(meta);
              }
            }}
            className={`group flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer transition-colors max-w-[160px] flex-shrink-0 ${
              isActive
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60'
            }`}
            title={meta.title}
          >
            <button
              ref={(element) => {
                if (element) tabRefs.current.set(meta.id, element);
                else tabRefs.current.delete(meta.id);
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => openWorkbenchTab(meta.id, { source: 'user' })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openWorkbenchTab(meta.id, { source: 'user' });
                  return;
                }
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const offset = event.key === 'ArrowRight' ? 1 : -1;
                const currentIndex = metas.findIndex((item) => item.id === meta.id);
                const next = metas[(currentIndex + offset + metas.length) % metas.length];
                if (!next) return;
                openWorkbenchTab(next.id, { source: 'user' });
                tabRefs.current.get(next.id)?.focus();
              }}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <span className="truncate">{meta.label}</span>
              {meta.isDirty && (
                <span className="text-amber-400 text-[10px] leading-none" title="未保存">●</span>
              )}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                requestClose(meta);
              }}
              className={`flex-shrink-0 p-0.5 rounded hover:bg-zinc-700 transition-opacity ${
                isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70 hover:opacity-100'
              }`}
              title={t.common.close}
              aria-label={t.common.close}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        );
      })}

      </div>{/* end scroll inner */}

      {/* 「设计画布」入口 — 标记当前会话为设计会话 + 打开 design-canvas tab，让用户边对话边看画布 */}
      <button
        type="button"
        data-testid="open-design-canvas"
        disabled={!currentSessionId}
        onClick={() => {
          if (!currentSessionId) return;
          useDesignCanvasStore.getState().markSessionDesignActive(currentSessionId);
          // M1-R2.c：真·跨会话认领前先把当前画布兜底落盘（claim 会清空旧画布 + 置 runDir=null，
          // 不落盘则未保存的手动编辑静默丢失）。仅真·跨会话（owner 非空且非当前）才需，沿用本仓
          // 「编辑后落盘」的 fire-and-forget 写法；no-op / 无主认领分支不重置不丢数据，无需落盘。
          const cs = useDesignCanvasStore.getState();
          if (cs.ownerSessionId && cs.ownerSessionId !== currentSessionId && cs.runDir) {
            void saveCanvasDoc(cs.runDir, cs.toDoc());
          }
          // 认领画布属主：当前会话非属主则重置画布（防上个设计会话内容残留泄漏）。
          useDesignCanvasStore.getState().claimCanvasForSession(currentSessionId);
          openWorkbenchTab('design-canvas');
        }}
        className="flex items-center justify-center w-6 h-6 flex-shrink-0 ml-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-zinc-500 disabled:hover:bg-transparent"
        title={t.design.openCanvasHint}
        aria-label={t.design.openCanvas}
      >
        <Palette className="w-3 h-3 text-fuchsia-400/80" />
      </button>

      {/* "+" 按钮 — 关掉的 tab 从这里重新开。在 scroll 容器外，popover 才不被 overflow 切 */}
      {canAddAny && (
        <div ref={addRef} className="relative flex-shrink-0 ml-0.5">
          <button
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            className="flex items-center justify-center w-6 h-6 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
            title={t.workbenchTabs.openPanel}
            aria-label={t.workbenchTabs.openPanel}
          >
            <Plus className="w-3 h-3" />
          </button>
          {addOpen && (
            <div className="absolute right-0 top-full mt-1 z-40 w-36 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
              {!hasOverview && (
                <button
                  type="button"
                  onClick={() => { openWorkbenchTab('overview'); setAddOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <LayoutDashboard className="w-3.5 h-3.5 text-cyan-400/80" />
                  {t.workbenchTabs.overviewLabel}
                </button>
              )}
              {!hasFiles && (
                <button
                  type="button"
                  onClick={() => { openWorkbenchTab('files'); setAddOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <FolderTree className="w-3.5 h-3.5 text-amber-400/80" />
                  {t.workbenchTabs.filesLabel}
                </button>
              )}
              {!hasBrowser && (
                <button
                  type="button"
                  onClick={() => { openWorkbenchTab('browser'); setAddOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <Globe2 className="w-3.5 h-3.5 text-emerald-400/80" />
                  {t.workbenchTabs.browserLabel}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
    <ConfirmDialog
      isOpen={pendingClose !== null}
      title="关闭未保存的文件？"
      message={pendingClose ? `${pendingClose.label} 的修改尚未保存，关闭后这些修改会丢失。` : ''}
      variant="danger"
      confirmText="关闭且不保存"
      onCancel={() => setPendingClose(null)}
      onConfirm={() => {
        if (pendingClose) closeWorkbenchTab(pendingClose.id);
        setPendingClose(null);
      }}
    />
    </>
  );
};
