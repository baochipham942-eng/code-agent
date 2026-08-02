import React, { useEffect, useMemo, useState } from 'react';
import { Archive, Check, ChevronRight, Film, Image as ImageIcon, LocateFixed, Trash2 } from 'lucide-react';
import {
  isReferenceNode,
  isVideoNode,
  type CanvasNode,
} from './designCanvasTypes';
import { formatCny } from '@shared/media/imageCost';
import { useI18n } from '../../hooks/useI18n';
import type { Translations } from '../../i18n';

export function layerDisplayName(node: CanvasNode, unnamed: string): string {
  return node.label || node.prompt || unnamed;
}

export function layerKindLabel(node: CanvasNode, labels: { image: string; video: string }): string {
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
  onDelete: (id: string) => void;
  onFocus: (id: string) => void;
  translations?: Translations;
}> = ({ nodes, selectedIds, onSelect, onRename, onSetChosen, onDiscard, onDelete, onFocus, translations }) => {
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

  // 纯内容组件（2026-08-01 工单①：图层/历史合并成一个边栏面板）——定位壳与 tab 条
  // 由 DesignCanvasSidePanel 提供，这里只渲染图层 tab 的内容。
  if (nodes.length === 0) {
    return <p className="px-3 py-3 text-[11px] text-zinc-500">{t.design.layerPanelEmpty}</p>;
  }

  return (
    <div className="flex min-h-0 flex-col text-xs text-zinc-200">
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
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-white/[0.24]"
            />
          </label>
          {/* X/Y/W/H/成本/父节点 是工程字段（2026-08-01 审美关返工#5：「展示的信息是不是过于多了」），
              收进默认折叠的 <details> 详情——字段一个不删，只是默认不展示。 */}
          <details data-testid="design-layer-details" className="group mt-2">
            <summary className="flex cursor-pointer select-none items-center gap-1 text-[11px] text-zinc-500 transition-colors hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
              {t.design.layerDetails}
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-zinc-500">
              <div className="rounded-md bg-white/[0.03] p-2">X<br /><span className="text-zinc-200">{Math.round(selected.x)}</span></div>
              <div className="rounded-md bg-white/[0.03] p-2">Y<br /><span className="text-zinc-200">{Math.round(selected.y)}</span></div>
              <div className="rounded-md bg-white/[0.03] p-2">W<br /><span className="text-zinc-200">{Math.round(selected.width)}</span></div>
              <div className="rounded-md bg-white/[0.03] p-2">H<br /><span className="text-zinc-200">{Math.round(selected.height)}</span></div>
              <div className="rounded-md bg-white/[0.03] p-2">{t.design.layerCost}<br /><span className="text-zinc-200">{typeof selected.costCny === 'number' ? formatCny(selected.costCny) : '—'}</span></div>
              <div className="rounded-md bg-white/[0.03] p-2">{t.design.layerParent}<br /><span className="text-zinc-200">{selected.parentId || '—'}</span></div>
            </div>
          </details>
          {/* K1 溢出折叠（2026-08-01）：窄栏下 grid-cols-3 会把「设为主版」劈成两行。
              改 flex：主动作保文字并占满剩余宽；「淘汰」「删除」收图标 + title 悬停提示，
              两个图标可区分（淘汰=归档 Archive、删除=垃圾桶 Trash2）。 */}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => onSetChosen(selected.id)}
              disabled={selected.discarded}
              className="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-200 disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" />
              {t.design.layerSetMain}
            </button>
            <button
              type="button"
              onClick={() => onDiscard(selected.id)}
              disabled={selected.discarded}
              title={t.design.layerDiscard}
              className="inline-flex items-center justify-center rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-xs text-red-200 disabled:opacity-40"
              aria-label={`${t.design.layerDiscard} ${layerDisplayName(selected, t.design.layerUnnamed)}`}
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(selected.id)}
              title={t.common.delete}
              className="inline-flex items-center justify-center rounded-md border border-red-500/25 bg-red-500/15 px-2 py-1.5 text-xs text-red-100"
              aria-label={`${t.common.delete} ${layerDisplayName(selected, t.design.layerUnnamed)}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
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
