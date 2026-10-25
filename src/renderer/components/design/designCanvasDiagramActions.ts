// 图解层（连线 / freeform 形状）的画布动作（从 DesignCanvas 抽出，纯函数搬移，
// 无逻辑改动）：直接读写 designCanvasStore，并复用 canvas.json 落盘链路。
import { useDesignCanvasStore } from './designCanvasStore';
import { saveCanvasDoc } from './designCanvasPersistence';
import type { CanvasShape } from './designDiagramTypes';

// —— 图解层辅助 ——
export const makeId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// 图解编辑后落盘（复用既有 canvas.json 写盘链路；无 runDir 时仅内存态，与节点编辑落盘模型一致）。
export const persistDiagram = (): void => {
  const rd = useDesignCanvasStore.getState().runDir;
  if (rd) void saveCanvasDoc(rd, useDesignCanvasStore.getState().toDoc());
};
export const onUpdateShape = (id: string, patch: Partial<CanvasShape>): void => {
  useDesignCanvasStore.getState().updateShape(id, patch);
  persistDiagram();
};
export const onAddConnector = (fromNodeId: string, toNodeId: string): void => {
  useDesignCanvasStore
    .getState()
    .addConnector({ id: makeId(), fromNodeId, toNodeId, createdAt: Date.now() });
  persistDiagram();
};
export const onDeleteSelectedDiagram = (): void => {
  const sel = useDesignCanvasStore.getState().selectedDiagram;
  if (!sel) return;
  if (sel.type === 'shape') useDesignCanvasStore.getState().deleteShape(sel.id);
  else useDesignCanvasStore.getState().deleteConnector(sel.id);
  persistDiagram();
};
