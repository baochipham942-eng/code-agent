// ============================================================================
// WorkbenchTabs - Unified tab bar for the right workbench panel
// ============================================================================
// Mixes pinned tabs ('task', 'skills') with per-file preview tabs. Click to
// activate, X or middle-click to close. Dirty indicator shown on preview tabs.

import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, ListTodo, Sparkles, FolderTree, Eye, Activity, ShieldCheck, Palette } from 'lucide-react';
import { useAppStore, type WorkbenchTabId } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useI18n } from '../hooks/useI18n';
import { useDisclosure } from '../hooks/useDisclosure';
import { useWorkspacePreviewModel } from '../hooks/useWorkspacePreviewModel';
import { useWorkbenchPresetStore } from '../stores/workbenchPresetStore';
import { useDesignCanvasStore } from './design/designCanvasStore';
import { saveCanvasDoc } from './design/designCanvasPersistence';

const PREVIEW_PREFIX = 'preview:';

function getFileName(path: string): string {
  const last = path.split('/').pop();
  return last && last.length > 0 ? last : path;
}

interface TabMeta {
  id: WorkbenchTabId;
  label: string;
  title: string; // tooltip
  isDirty: boolean;
}

export const WorkbenchTabs: React.FC = () => {
  const { t } = useI18n();
  const workbenchTabs = useAppStore((s) => s.workbenchTabs);
  const activeWorkbenchTab = useAppStore((s) => s.activeWorkbenchTab);
  const previewTabs = useAppStore((s) => s.previewTabs);
  const setActiveWorkbenchTab = useAppStore((s) => s.setActiveWorkbenchTab);
  const closeWorkbenchTab = useAppStore((s) => s.closeWorkbenchTab);
  const openWorkbenchTab = useAppStore((s) => s.openWorkbenchTab);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const { isStandard } = useDisclosure();
  const workspacePreviewItems = useWorkspacePreviewModel();
  const savedPresetCount = useWorkbenchPresetStore((s) => s.presets.length);
  const savedRecipeCount = useWorkbenchPresetStore((s) => s.recipes.length);

  // "+" 按钮的 popover 状态：列出未打开的 Task/Skills/Files 让用户重开
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement | null>(null);
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
  const hasTask = workbenchTabs.includes('task');
  const hasSkills = workbenchTabs.includes('skills');
  const hasFiles = workbenchTabs.includes('files');
  const hasWorkspacePreview = workbenchTabs.includes('workspace-preview');
  const hasContext = workbenchTabs.includes('context');
  const hasAudit = workbenchTabs.includes('audit');
  const canAddAny =
    !hasTask ||
    (!hasSkills && isStandard) ||
    !hasFiles ||
    !hasWorkspacePreview ||
    !hasContext ||
    !hasAudit;

  const metas: TabMeta[] = workbenchTabs.map((id) => {
    if (id === 'task') {
      return { id, label: t.taskPanel.title, title: t.taskPanel.title, isDirty: false };
    }
    if (id === 'skills') {
      return { id, label: 'Skills', title: 'Session Skills', isDirty: false };
    }
    if (id === 'files') {
      return { id, label: '文件', title: '文件浏览器', isDirty: false };
    }
    if (id === 'workspace-preview') {
      const count = workspacePreviewItems.length + savedPresetCount + savedRecipeCount;
      return {
        id,
        label: count > 0 ? `Assets ${count}` : 'Assets',
        title: 'Workspace Assets',
        isDirty: false,
      };
    }
    if (id === 'context') {
      return { id, label: '上下文', title: '上下文占用与来源拆分', isDirty: false };
    }
    if (id === 'audit') {
      return { id, label: 'Audit', title: 'Replay / 会话质量审计', isDirty: false };
    }
    if (id === 'design-canvas') {
      return { id, label: t.design.canvasTabLabel, title: t.design.canvasTabLabel, isDirty: false };
    }
    const path = id.slice(PREVIEW_PREFIX.length);
    const previewTab = previewTabs.find((p) => p.path === path);
    const isDirty = previewTab ? previewTab.content !== previewTab.savedContent : false;
    return { id, label: getFileName(path), title: path, isDirty };
  });

  return (
    <div className="flex items-center px-2 py-1 border-b border-zinc-700 bg-zinc-900">
      {/* tabs 自己滚动；[+] 不在滚动区里，popover 才能 escape overflow 弹出来 */}
      <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-none flex-1 min-w-0">
      {metas.map((meta) => {
        const isActive = meta.id === activeWorkbenchTab;
        return (
          <div
            key={meta.id}
            onClick={() => setActiveWorkbenchTab(meta.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeWorkbenchTab(meta.id);
              }
            }}
            className={`group flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer transition-colors max-w-[160px] flex-shrink-0 ${
              isActive
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60'
            }`}
            title={meta.title}
          >
            <span className="truncate">{meta.label}</span>
            {meta.isDirty && (
              <span className="text-amber-400 text-[10px] leading-none" title="未保存">●</span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeWorkbenchTab(meta.id);
              }}
              className={`flex-shrink-0 p-0.5 rounded hover:bg-zinc-700 transition-opacity ${
                isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70 hover:opacity-100'
              }`}
              title="关闭"
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
          useSessionStore.getState().markSessionDesignActive(currentSessionId);
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
            title="打开面板"
            aria-label="打开面板"
          >
            <Plus className="w-3 h-3" />
          </button>
          {addOpen && (
            <div className="absolute right-0 top-full mt-1 z-40 w-36 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
              {!hasTask && (
                <button
                  type="button"
                  onClick={() => { openWorkbenchTab('task'); setAddOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <ListTodo className="w-3.5 h-3.5" />
                  {t.taskPanel.title}
                </button>
              )}
              {!hasSkills && isStandard && (
                <button
                  type="button"
                  onClick={() => { openWorkbenchTab('skills'); setAddOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <Sparkles className="w-3.5 h-3.5 text-purple-400/80" />
                  Skills
                </button>
              )}
              {!hasFiles && (
                <button
                  type="button"
                  onClick={() => { openWorkbenchTab('files'); setAddOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <FolderTree className="w-3.5 h-3.5 text-amber-400/80" />
                  文件
                </button>
              )}
              {!hasWorkspacePreview && (
                <button
                  type="button"
                  onClick={() => { openWorkbenchTab('workspace-preview'); setAddOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <Eye className="w-3.5 h-3.5 text-cyan-400/80" />
                  Assets
                </button>
              )}
              {!hasContext && (
                <button
                  type="button"
                  onClick={() => { openWorkbenchTab('context'); setAddOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <Activity className="w-3.5 h-3.5 text-emerald-400/80" />
                  上下文
                </button>
              )}
              {!hasAudit && (
                <button
                  type="button"
                  onClick={() => { openWorkbenchTab('audit'); setAddOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-sky-400/80" />
                  Audit
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
