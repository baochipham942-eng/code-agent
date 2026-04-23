// ============================================================================
// WorkbenchTabs - Unified tab bar for the right workbench panel
// ============================================================================
// Mixes pinned tabs ('task', 'skills') with per-file preview tabs. Click to
// activate, X or middle-click to close. Dirty indicator shown on preview tabs.

import React from 'react';
import { X } from 'lucide-react';
import { useAppStore, type WorkbenchTabId } from '../stores/appStore';
import { useI18n } from '../hooks/useI18n';

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

  if (workbenchTabs.length === 0) return null;

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
    const path = id.slice(PREVIEW_PREFIX.length);
    const previewTab = previewTabs.find((p) => p.path === path);
    const isDirty = previewTab ? previewTab.content !== previewTab.savedContent : false;
    return { id, label: getFileName(path), title: path, isDirty };
  });

  return (
    <div className="flex items-center gap-0.5 px-2 py-1 border-b border-zinc-700 bg-zinc-900 overflow-x-auto scrollbar-none">
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
    </div>
  );
};
