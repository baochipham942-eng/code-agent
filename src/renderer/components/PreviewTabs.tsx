// ============================================================================
// PreviewTabs - Tab bar for multi-file preview
// ============================================================================

import React from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';

function getFileName(path: string): string {
  const last = path.split('/').pop();
  return last && last.length > 0 ? last : path;
}

export const PreviewTabs: React.FC = () => {
  const previewTabs = useAppStore((s) => s.previewTabs);
  const activePreviewTabId = useAppStore((s) => s.activePreviewTabId);
  const setActivePreviewTab = useAppStore((s) => s.setActivePreviewTab);
  const closePreviewTab = useAppStore((s) => s.closePreviewTab);

  if (previewTabs.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 px-2 py-1 border-b border-zinc-700 bg-zinc-900 overflow-x-auto scrollbar-none">
      {previewTabs.map((tab) => {
        const isActive = tab.id === activePreviewTabId;
        const isDirty = tab.content !== tab.savedContent;
        return (
          <div
            key={tab.id}
            onClick={() => setActivePreviewTab(tab.id)}
            onMouseDown={(e) => {
              // Middle-click closes the tab (button === 1)
              if (e.button === 1) {
                e.preventDefault();
                closePreviewTab(tab.id);
              }
            }}
            className={`group flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer transition-colors max-w-[160px] flex-shrink-0 ${
              isActive
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60'
            }`}
            title={tab.path}
          >
            <span className="truncate">{getFileName(tab.path)}</span>
            {isDirty && (
              <span className="text-amber-400 text-[10px] leading-none" title="未保存">●</span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closePreviewTab(tab.id);
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
