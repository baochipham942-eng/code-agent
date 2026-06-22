// T2 信任 UI：设计画布的成本透明 + undo/redo 历史面板。
// 数据真理源是 canvas 节点（designCanvasStore）；本组件把节点适配成 variant spine，
// 用 variantHistory 纯逻辑算每个版本槽的时间线与前/后一版，回滚=把目标版设为主版（onSetChosen），
// 非破坏式、可 redo。每步可命名（onRename），并展示 BYOK 实际花费与累计花费。
//
// 拆成「展示组件 View（吃 props，纯渲染）+ 容器（接 store）」：View 无 store 依赖，
// 便于无 jsdom 环境下 renderToStaticMarkup 真组件做 dogfood/视觉验证。
import React, { useMemo, useState } from 'react';
import { Undo2, Redo2, Pencil, Check, RotateCcw, CircleDot } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { formatCny } from '@shared/media/imageCost';
import { useDesignCanvasStore } from './designCanvasStore';
import { canvasNodeToVariant } from './variantAdapters';
import { groupKey, type VariantSpine } from './variantSpine';
import {
  slotTimeline,
  currentVariant,
  previousVariantId,
  nextVariantId,
  canUndo,
  canRedo,
} from './variantHistory';
import type { CanvasNode } from './designCanvasTypes';

function stepName(node: CanvasNode | undefined, fallback: string): string {
  const name = node?.label ?? node?.prompt;
  return name && name.trim().length > 0 ? name : fallback;
}

export interface DesignCostHistoryViewProps {
  nodes: CanvasNode[];
  onSetChosen: (id: string) => void;
  onRename: (id: string, label: string) => void;
}

export const DesignCostHistoryView: React.FC<DesignCostHistoryViewProps> = ({
  nodes,
  onSetChosen,
  onRename,
}) => {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const spine: VariantSpine = useMemo(
    () => ({ version: 1, variants: nodes.map(canvasNodeToVariant) }),
    [nodes],
  );
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);

  // 累计花费：所有出图/重绘步骤实际花费之和（含已淘汰——钱已真实花掉，BYOK 必须诚实）。
  const totalSpend = useMemo(
    () => nodes.reduce((sum, n) => sum + (typeof n.costCny === 'number' ? n.costCny : 0), 0),
    [nodes],
  );

  // 活跃版本槽（按 groupKey 去重，保留首次出现顺序）。
  const slots = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const v of spine.variants) {
      if (v.discarded) continue;
      const k = groupKey(v);
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
    return order;
  }, [spine]);

  const startRename = (node: CanvasNode): void => {
    setEditingId(node.id);
    setDraft(node.label ?? node.prompt ?? '');
  };
  const saveRename = (): void => {
    if (editingId) {
      const v = draft.trim();
      if (v.length > 0) onRename(editingId, v);
    }
    setEditingId(null);
    setDraft('');
  };

  const hasSteps = slots.length > 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">{t.design.historyPanelTitle}</span>
        <span className="text-[11px] text-zinc-500">
          {t.design.historyTotalSpend}{' '}
          <span className="font-mono text-emerald-300">{totalSpend === 0 ? t.design.costFree : formatCny(totalSpend)}</span>
        </span>
      </div>

      {!hasSteps && <p className="text-[11px] leading-snug text-zinc-500">{t.design.historyPanelEmpty}</p>}

      {slots.map((slot) => {
        const timeline = slotTimeline(spine, slot);
        const current = currentVariant(spine, slot);
        const undoId = previousVariantId(spine, slot);
        const redoId = nextVariantId(spine, slot);
        return (
          <div
            key={slot}
            className="flex flex-col gap-1.5 border-t border-white/[0.05] pt-2 first:border-t-0 first:pt-0"
          >
            {/* 槽级 undo/redo */}
            {timeline.length > 1 && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => undoId && onSetChosen(undoId)}
                  disabled={!canUndo(spine, slot)}
                  title={t.design.historyUndo}
                  className="inline-flex items-center gap-1 rounded-md border border-white/[0.10] px-1.5 py-0.5 text-[11px] text-zinc-300 transition-colors hover:text-zinc-100 disabled:opacity-30"
                >
                  <Undo2 className="h-3 w-3" />
                  {t.design.historyUndo}
                </button>
                <button
                  type="button"
                  onClick={() => redoId && onSetChosen(redoId)}
                  disabled={!canRedo(spine, slot)}
                  title={t.design.historyRedo}
                  className="inline-flex items-center gap-1 rounded-md border border-white/[0.10] px-1.5 py-0.5 text-[11px] text-zinc-300 transition-colors hover:text-zinc-100 disabled:opacity-30"
                >
                  <Redo2 className="h-3 w-3" />
                  {t.design.historyRedo}
                </button>
              </div>
            )}

            {/* 步骤时间线（最新在上） */}
            {[...timeline].reverse().map((v) => {
              const node = nodeById.get(v.id);
              const isCurrent = current?.id === v.id;
              const opLabel = v.parentId ? t.design.historyStepEdit : t.design.historyStepGenerate;
              // 免费档模型（如 cogview-3-flash，costCny=0）显示「免费」而非 ¥0.00。
              const cost =
                typeof node?.costCny === 'number'
                  ? node.costCny === 0
                    ? t.design.costFree
                    : formatCny(node.costCny)
                  : null;
              const editing = editingId === v.id;
              return (
                <div
                  key={v.id}
                  className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] ${
                    isCurrent ? 'bg-fuchsia-400/10 text-fuchsia-100' : 'text-zinc-400'
                  }`}
                >
                  <CircleDot
                    className={`h-3 w-3 shrink-0 ${isCurrent ? 'text-fuchsia-300' : 'text-zinc-600'}`}
                  />
                  {editing ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          saveRename();
                        } else if (e.key === 'Escape') {
                          setEditingId(null);
                        }
                      }}
                      placeholder={t.design.historyRenamePlaceholder}
                      className="min-w-0 flex-1 rounded border border-white/[0.15] bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-zinc-100 focus:border-white/[0.3] focus:outline-none"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate" title={stepName(node, opLabel)}>
                      {stepName(node, opLabel)}
                    </span>
                  )}
                  <span className="shrink-0 rounded bg-white/[0.06] px-1 py-px text-[10px] text-zinc-400">
                    {opLabel}
                  </span>
                  {cost && <span className="shrink-0 font-mono text-emerald-300/90">{cost}</span>}
                  {isCurrent && (
                    <span className="shrink-0 text-[10px] text-fuchsia-300">{t.design.historyCurrent}</span>
                  )}
                  {editing ? (
                    <button
                      type="button"
                      onClick={saveRename}
                      title={t.design.historyRenameSave}
                      className="shrink-0 text-emerald-300 hover:text-emerald-200"
                    >
                      <Check className="h-3 w-3" />
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => node && startRename(node)}
                        title={t.design.historyRename}
                        className="shrink-0 text-zinc-500 hover:text-zinc-200"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      {!isCurrent && (
                        <button
                          type="button"
                          onClick={() => onSetChosen(v.id)}
                          title={t.design.historyRollbackTo}
                          className="shrink-0 text-zinc-500 hover:text-fuchsia-200"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

/** 容器：接 designCanvasStore，回滚=setChosen，命名=renameNode。 */
export const DesignCostHistory: React.FC = () => {
  const nodes = useDesignCanvasStore((s) => s.nodes);
  const setChosen = useDesignCanvasStore((s) => s.setChosen);
  const renameNode = useDesignCanvasStore((s) => s.renameNode);
  return <DesignCostHistoryView nodes={nodes} onSetChosen={setChosen} onRename={renameNode} />;
};
