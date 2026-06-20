// A/B 版本对比浮层（Cowart 式 P3）。两版等高并排，看清差异（区别于星流只能画布上人眼扫）。
// 每版可「设为主版」(标记 chosen,清同组其他)或「淘汰」(删节点)。改动落盘 canvas.json。
import React, { useEffect, useState } from 'react';
import { X, Star, Trash2 } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useDesignCanvasStore } from './designCanvasStore';
import { saveCanvasDoc } from './designCanvasPersistence';
import { readWorkspaceImageAsDataUrl } from './designFiles';
import type { CanvasImageNode } from './designCanvasTypes';

async function persist(runDir: string | null): Promise<void> {
  if (runDir) await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
}

const Pane: React.FC<{
  node: CanvasImageNode;
  runDir: string | null;
  onChoose: () => void;
  onDiscard: () => void;
}> = ({ node, runDir, onChoose, onDiscard }) => {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const u = /^(data:|https?:)/.test(node.src)
        ? node.src
        : runDir
          ? await readWorkspaceImageAsDataUrl(`${runDir.replace(/\/+$/, '')}/${node.src}`)
          : null;
      if (alive) setUrl(u);
    })();
    return () => {
      alive = false;
    };
  }, [node.src, runDir]);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-white/[0.1] bg-zinc-950">
        {url ? (
          <img src={url} alt="version" className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-xs text-zinc-600">…</span>
        )}
        {node.chosen && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-emerald-500/90 px-1.5 py-0.5 text-[10px] text-white">
            <Star className="h-3 w-3" /> {t.design.mainVersion}
          </span>
        )}
      </div>
      <p className="line-clamp-2 text-[11px] text-zinc-400" title={node.prompt}>
        {node.prompt || (node.parentId ? t.design.versionEdited : t.design.versionOriginal)}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onChoose}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-500/90 px-2 py-1.5 text-xs text-white hover:bg-emerald-500"
        >
          <Star className="h-3.5 w-3.5" /> {t.design.setMainVersion}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-white/[0.1] px-2 py-1.5 text-xs text-zinc-400 hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" /> {t.design.discardVersion}
        </button>
      </div>
    </div>
  );
};

export const DesignCompareOverlay: React.FC<{
  nodeA: CanvasImageNode;
  nodeB: CanvasImageNode;
  runDir: string | null;
  onClose: () => void;
}> = ({ nodeA, nodeB, runDir, onClose }) => {
  const { t } = useI18n();
  const setChosen = useDesignCanvasStore((s) => s.setChosen);
  const deleteNode = useDesignCanvasStore((s) => s.deleteNode);

  const choose = async (id: string): Promise<void> => {
    setChosen(id);
    await persist(runDir);
  };
  const discard = async (id: string): Promise<void> => {
    deleteNode(id);
    await persist(runDir);
    onClose();
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col gap-3 bg-zinc-950/85 p-6 backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-200">{t.design.compareTitle}</span>
        <button type="button" onClick={onClose} className="text-zinc-400 hover:text-zinc-100">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 gap-4">
        <Pane node={nodeA} runDir={runDir} onChoose={() => void choose(nodeA.id)} onDiscard={() => void discard(nodeA.id)} />
        <Pane node={nodeB} runDir={runDir} onChoose={() => void choose(nodeB.id)} onDiscard={() => void discard(nodeB.id)} />
      </div>
    </div>
  );
};
