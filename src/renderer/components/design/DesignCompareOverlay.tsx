// canvas 侧 A/B 对比浮层：薄封装通用 VariantCompareView。
// 把画布节点适配成 variant，设主版→setChosen、淘汰→discardNode(软删除)，落盘 canvas.json。
import React from 'react';
import { useDesignCanvasStore } from './designCanvasStore';
import { saveCanvasDoc } from './designCanvasPersistence';
import { canvasNodeToVariant } from './variantAdapters';
import { VariantCompareView } from './VariantCompareView';
import type { CanvasImageNode } from './designCanvasTypes';

async function persist(runDir: string | null): Promise<void> {
  if (runDir) await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
}

export const DesignCompareOverlay: React.FC<{
  nodeA: CanvasImageNode;
  nodeB: CanvasImageNode;
  runDir: string | null;
  onClose: () => void;
}> = ({ nodeA, nodeB, runDir, onClose }) => {
  const setChosen = useDesignCanvasStore((s) => s.setChosen);
  const discardNode = useDesignCanvasStore((s) => s.discardNode);

  const onPin = (id: string): void => {
    setChosen(id);
    void persist(runDir);
  };
  const onDiscard = (id: string): void => {
    discardNode(id);
    void persist(runDir);
    onClose();
  };

  return (
    <VariantCompareView
      variantA={canvasNodeToVariant(nodeA)}
      variantB={canvasNodeToVariant(nodeB)}
      runDir={runDir}
      onPin={onPin}
      onDiscard={onDiscard}
      onClose={onClose}
    />
  );
};
