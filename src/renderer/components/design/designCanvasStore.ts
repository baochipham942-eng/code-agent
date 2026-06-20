// 设计画布运行态 store（Cowart 式无限画布）。
// 真理源是磁盘 canvas.json（见 designCanvasPersistence），本 store 只持运行态，
// 不挂 persist——避免与磁盘存档双源（详见 docs/designs/design-canvas-cowart.md §2.2）。
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
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
  /** 出图进行中（驱动生成按钮 spinner）。 */
  generating: boolean;
  error: string | null;

  /** 载入一份存档（切换 run / 刷新恢复）。 */
  loadDoc: (runDir: string | null, doc: DesignCanvasDoc) => void;
  /** 清空到空画布（保留 runDir）。 */
  resetCanvas: () => void;
  addNode: (node: CanvasImageNode) => void;
  updateNode: (id: string, patch: Partial<Omit<CanvasImageNode, 'id'>>) => void;
  deleteNode: (id: string) => void;
  /** 选为主版：标记该节点 chosen，并清除同版本组（同 parentId）其他节点的主版标记。 */
  setChosen: (id: string) => void;
  setCamera: (camera: CanvasCamera) => void;
  setSelected: (ids: string[]) => void;
  setGenerating: (generating: boolean) => void;
  setError: (error: string | null) => void;
  /** 导出当前画布为存档文档（写盘用）。 */
  toDoc: () => DesignCanvasDoc;
}

export const useDesignCanvasStore = create<DesignCanvasState>()(
  persist(
    (set, get) => ({
  runDir: null,
  nodes: [],
  camera: { ...emptyCanvasDoc().camera },
  selectedIds: [],
  generating: false,
  error: null,

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
  deleteNode: (id) =>
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      selectedIds: s.selectedIds.filter((sid) => sid !== id),
    })),
  setChosen: (id) =>
    set((s) => {
      const target = s.nodes.find((n) => n.id === id);
      if (!target) return {};
      const group = target.parentId; // 同一版本组 = 同 parentId
      return {
        nodes: s.nodes.map((n) => {
          if (n.id === id) return { ...n, chosen: true };
          if (n.parentId === group) return { ...n, chosen: false };
          return n;
        }),
      };
    }),
  setCamera: (camera) => set({ camera }),
  setSelected: (selectedIds) => set({ selectedIds }),
  setGenerating: (generating) => set({ generating }),
  setError: (error) => set({ error }),
  toDoc: () => {
    const s = get();
    return { version: 1, nodes: s.nodes, camera: s.camera };
  },
    }),
    {
      name: 'code-agent-design-canvas',
      version: 1,
      // 只持久化 runDir（画布所属 run）；节点/相机从磁盘 canvas.json 恢复，运行态不持久。
      partialize: (s) => ({ runDir: s.runDir }),
    },
  ),
);
