import React, { useEffect, useMemo, useState } from 'react';
import { Check, Film, Image as ImageIcon, Layers, LocateFixed, Trash2 } from 'lucide-react';
import {
  isReferenceNode,
  isVideoNode,
  type CanvasNode,
} from './designCanvasTypes';
import { formatCny } from '@shared/media/imageCost';
import { useI18n } from '../../hooks/useI18n';
import type { Translations } from '../../i18n';

export function layerDisplayName(node: CanvasNode, unnamed = '未命名节点'): string {
  return node.label || node.prompt || unnamed;
}

export function layerKindLabel(node: CanvasNode, labels: { image: string; video: string } = { image: '图片', video: '视频' }): string {
  return isVideoNode(node) ? labels.video : labels.image;
}

export function orderedLayerNodes(nodes: readonly CanvasNode[]): CanvasNode[] {
  return [...nodes].sort((a, b) => {
    if (a.discarded !== b.discarded) return a.discarded ? 1 : -1;
    return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
  });
}

export const DesignLayerPanel: React.FC<{
  nodes: CanvasNode[];
  selectedIds: string[];
  onSelect: (id: string, additive: boolean) => void;
  onRename: (id: string, label: string) => void;
  onSetChosen: (id: string) => void;
  onDiscard: (id: string) => void;
  onFocus: (id: string) => void;
  translations?: Translations;
}> = ({ nodes, selectedIds, onSelect, onRename, onSetChosen, onDiscard, onFocus, translations }) => {
  const { t: runtimeT } = useI18n();
  const t = translations ?? runtimeT;
  const ordered = useMemo(() => orderedLayerNodes(nodes), [nodes]);
  const selected = selectedIds.length === 1 ? nodes.find((node) => node.id === selectedIds[0]) ?? null : null;
  const [draftLabel, setDraftLabel] = useState('');

  useEffect(() => {
    setDraftLabel(selected ? layerDisplayName(selected, t.design.layerUnnamed) : '');
  }, [selected?.id, selected?.label, selected?.prompt, t.design.layerUnnamed]);

  const commit = (): void => {
    if (!selected) return;
    const next = draftLabel.trim();
    if (next && next !== selected.label) onRename(selected.id, next);
  };

  if (nodes.length === 0) return null;

  return (
    <div className="absolute right-4 top-14 z-10 flex max-h-[70%] w-80 flex-col overflow-hidden rounded-lg border border-white/[0.10] bg-zinc-950/85 text-xs text-zinc-200 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2">
        <div className="flex items-center gap-2 text-zinc-200">
          <Layers className="h-3.5 w-3.5 text-fuchsia-300" />
          <span>{t.design.layerPanelTitle}</span>
        </div>
        <span className="text-[11px] text-zinc-500">
          {ordered.filter((node) => !node.discarded).length}/{ordered.length}
        </span>
      </div>

      <div className="max-h-40 overflow-auto p-2">
        {ordered.map((node) => {
          const active = selectedIds.includes(node.id);
          return (
            <div key={node.id} className="mb-1 flex items-center gap-1">
              <button
                type="button"
                onClick={(e) => onSelect(node.id, e.shiftKey || e.metaKey)}
                className={`min-w-0 flex-1 rounded-md border px-2 py-2 text-left transition-colors ${
                  active
                    ? 'border-fuchsia-400/70 bg-fuchsia-500/15 text-zinc-50'
                    : 'border-transparent bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]'
                } ${node.discarded ? 'opacity-45' : ''}`}
              >
                <div className="flex items-center gap-2">
                  {isVideoNode(node) ? (
                    <Film className="h-3.5 w-3.5 text-sky-300" />
                  ) : (
                    <ImageIcon className="h-3.5 w-3.5 text-emerald-300" />
                  )}
                  <span className="truncate">{layerDisplayName(node, t.design.layerUnnamed)}</span>
                  {node.chosen && <span className="rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-300">{t.design.layerMainBadge}</span>}
                  {node.discarded && <span className="rounded bg-zinc-700/60 px-1 text-[10px] text-zinc-400">{t.design.layerDiscardedBadge}</span>}
                </div>
                <div className="mt-1 flex gap-1 pl-5 text-[10px] text-zinc-500">
                  <span>{layerKindLabel(node, { image: t.design.layerKindImage, video: t.design.layerKindVideo })}</span>
                  <span>{isReferenceNode(node) ? t.design.layerRoleReference : t.design.layerRoleOutput}</span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => onFocus(node.id)}
                className="rounded-md border border-white/[0.08] bg-white/[0.03] p-2 text-zinc-400 hover:text-zinc-100"
                aria-label={`${t.design.layerFocusLabel} ${layerDisplayName(node, t.design.layerUnnamed)}`}
              >
                <LocateFixed className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {selected ? (
        <div className="border-t border-white/[0.08] p-3">
          <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
            <span>{t.design.layerNameLabel}</span>
            <input
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-white/[0.24]"
            />
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-zinc-500">
            <div className="rounded-md bg-white/[0.03] p-2">X<br /><span className="text-zinc-200">{Math.round(selected.x)}</span></div>
            <div className="rounded-md bg-white/[0.03] p-2">Y<br /><span className="text-zinc-200">{Math.round(selected.y)}</span></div>
            <div className="rounded-md bg-white/[0.03] p-2">W<br /><span className="text-zinc-200">{Math.round(selected.width)}</span></div>
            <div className="rounded-md bg-white/[0.03] p-2">H<br /><span className="text-zinc-200">{Math.round(selected.height)}</span></div>
            <div className="rounded-md bg-white/[0.03] p-2">{t.design.layerCost}<br /><span className="text-zinc-200">{typeof selected.costCny === 'number' ? formatCny(selected.costCny) : '—'}</span></div>
            <div className="rounded-md bg-white/[0.03] p-2">{t.design.layerParent}<br /><span className="text-zinc-200">{selected.parentId || '—'}</span></div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onSetChosen(selected.id)}
              disabled={selected.discarded}
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-200 disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" />
              {t.design.layerSetMain}
            </button>
            <button
              type="button"
              onClick={() => onDiscard(selected.id)}
              disabled={selected.discarded}
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-xs text-red-200 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t.design.layerDiscard}
            </button>
          </div>
        </div>
      ) : (
        <p className="border-t border-white/[0.08] px-3 py-3 text-[11px] text-zinc-500">
          {t.design.layerEmptyInspector}
        </p>
      )}
    </div>
  );
};
