// ADR-026 三刀：已淘汰节点恢复入口（软删的找回路径）。画布角落的小托盘，
// 列出 discarded 节点，一键恢复（restoreNode + 落盘）。无淘汰时不渲染。
import React, { useState } from 'react';
import { Trash2, RotateCcw, ChevronDown } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useDesignCanvasStore } from './designCanvasStore';
import { saveCanvasDoc } from './designCanvasPersistence';

export const DiscardedNodesTray: React.FC = () => {
  const { t } = useI18n();
  const s = t.design;
  const nodes = useDesignCanvasStore((st) => st.nodes);
  const restoreNode = useDesignCanvasStore((st) => st.restoreNode);
  const [open, setOpen] = useState(false);

  const discarded = nodes.filter((n) => n.discarded);
  if (discarded.length === 0) return null;

  const onRestore = (id: string): void => {
    restoreNode(id);
    const { runDir, toDoc } = useDesignCanvasStore.getState();
    if (runDir) void saveCanvasDoc(runDir, toDoc());
  };

  return (
    <div data-testid="discarded-tray" className="pointer-events-auto absolute bottom-4 left-4 z-20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900/90 px-2.5 py-1.5 text-xs text-zinc-300 shadow-lg backdrop-blur hover:bg-zinc-800/90"
      >
        <Trash2 className="h-3.5 w-3.5 text-zinc-400" />
        {s.discardedTrayCount.replace('{n}', String(discarded.length))}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-1 w-64 rounded-lg border border-white/10 bg-zinc-900/95 p-2 shadow-xl backdrop-blur">
          <p className="mb-1 px-1 text-[11px] font-medium text-zinc-400">{s.discardedTrayTitle}</p>
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {discarded.map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-white/[0.04]">
                <span className="truncate text-xs text-zinc-300">{n.label?.trim() || n.prompt?.trim() || n.id}</span>
                <button
                  type="button"
                  data-testid={`restore-${n.id}`}
                  onClick={() => onRestore(n.id)}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
                >
                  <RotateCcw className="h-3 w-3" />
                  {s.discardedRestore}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
