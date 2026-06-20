// 设计画布运行态 store（Cowart 式无限画布）。
// 真理源是磁盘 canvas.json（见 designCanvasPersistence），本 store 只持运行态，
// 不挂 persist——避免与磁盘存档双源（详见 docs/designs/design-canvas-cowart.md §2.2）。
import { create } from 'zustand';
import {
  emptyCanvasDoc,
  type CanvasCamera,
  type CanvasImageNode,
  type DesignCanvasDoc,
} from './designCanvasTypes';

interface DesignCanvasState {
  /** 当前画布所属 run 目录（决定存档落点）；null=尚无生成的临时画布。 */
  runDir: string | null;
  nodes: CanvasImageNode[];
  camera: CanvasCamera;
  selectedIds: string[];

  /** 载入一份存档（切换 run / 刷新恢复）。 */
  loadDoc: (runDir: string | null, doc: DesignCanvasDoc) => void;
  /** 清空到空画布（保留 runDir）。 */
  resetCanvas: () => void;
  addNode: (node: CanvasImageNode) => void;
  updateNode: (id: string, patch: Partial<Omit<CanvasImageNode, 'id'>>) => void;
  setCamera: (camera: CanvasCamera) => void;
  setSelected: (ids: string[]) => void;
  /** 导出当前画布为存档文档（写盘用）。 */
  toDoc: () => DesignCanvasDoc;
}

export const useDesignCanvasStore = create<DesignCanvasState>()((set, get) => ({
  runDir: null,
  nodes: [],
  camera: { ...emptyCanvasDoc().camera },
  selectedIds: [],

  loadDoc: (runDir, doc) =>
    set({ runDir, nodes: doc.nodes, camera: doc.camera, selectedIds: [] }),
  resetCanvas: () => {
    const empty = emptyCanvasDoc();
    set({ nodes: empty.nodes, camera: empty.camera, selectedIds: [] });
  },
  addNode: (node) => set((s) => ({ nodes: [...s.nodes, node] })),
  updateNode: (id, patch) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    })),
  setCamera: (camera) => set({ camera }),
  setSelected: (selectedIds) => set({ selectedIds }),
  toDoc: () => {
    const s = get();
    return { version: 1, nodes: s.nodes, camera: s.camera };
  },
}));
