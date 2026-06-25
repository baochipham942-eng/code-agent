// 设计画布运行态 store（Cowart 式无限画布）。
// 真理源是磁盘 canvas.json（见 designCanvasPersistence），本 store 只持运行态，
// 不挂 persist——避免与磁盘存档双源（详见 docs/designs/design-canvas-cowart.md §2.2）。
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  emptyCanvasDoc,
  type CanvasCamera,
  type CanvasNode,
  type DesignCanvasDoc,
} from './designCanvasTypes';
import { groupKey } from './variantSpine';
import {
  emptyEditHistory,
  pushSnapshot,
  undoEdit as applyUndo,
  redoEdit as applyRedo,
  clearHistory,
  canEditUndo as canUndo,
  canEditRedo as canRedo,
  reconcileUndoFrame,
  type EditHistoryStack,
} from './canvasEditHistory';

interface DesignCanvasState {
  /** 当前画布所属 run 目录（决定存档落点）；null=尚无生成的临时画布。 */
  runDir: string | null;
  nodes: CanvasNode[];
  camera: CanvasCamera;
  selectedIds: string[];
  /** 出图进行中（驱动生成按钮 spinner）。 */
  generating: boolean;
  error: string | null;
  /** Layer1 编辑历史栈：节点移动/缩放/删除/重命名的快照。生成产物走 Layer2 variant spine，不进本栈。 */
  editHistory: EditHistoryStack;

  /** 载入一份存档（切换 run / 刷新恢复）。 */
  loadDoc: (runDir: string | null, doc: DesignCanvasDoc) => void;
  /** 清空到空画布（保留 runDir）。 */
  resetCanvas: () => void;
  addNode: (node: CanvasNode) => void;
  updateNode: (id: string, patch: Partial<Omit<CanvasNode, 'id'>>) => void;
  deleteNode: (id: string) => void;
  /** 淘汰（软删除）：标记 discarded，节点落盘保留；若淘汰的是主版，自动把同槽最新活跃版升为主版。 */
  discardNode: (id: string) => void;
  /** 选为主版：标记该节点 chosen，并清除同版本槽（groupKey=parentId??id）其他节点的主版标记。 */
  setChosen: (id: string) => void;
  /** 为某一步命名（T2 可逆命名步）：写入 label，不存在则静默无操作。 */
  renameNode: (id: string, label: string) => void;
  setCamera: (camera: CanvasCamera | ((camera: CanvasCamera) => CanvasCamera)) => void;
  setSelected: (ids: string[]) => void;
  setGenerating: (generating: boolean) => void;
  setError: (error: string | null) => void;
  /** 撤销上一步直接编辑（仅 Layer1，不动 variant spine）。 */
  undoEdit: () => void;
  /** 重做上一步被撤销的编辑（仅 Layer1）。 */
  redoEdit: () => void;
  /** 清空编辑历史（生成成功提交后 / loadDoc / resetCanvas 调用）。 */
  clearEditHistory: () => void;
  canEditUndo: () => boolean;
  canEditRedo: () => boolean;
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
  editHistory: emptyEditHistory(),

  loadDoc: (runDir, doc) =>
    set({ runDir, nodes: doc.nodes, camera: doc.camera, selectedIds: [], editHistory: clearHistory() }),
  resetCanvas: () => {
    const empty = emptyCanvasDoc();
    set({ nodes: empty.nodes, camera: empty.camera, selectedIds: [], editHistory: clearHistory() });
  },
  // addNode = 生成产物落画布，属 Layer2（variant spine），不进 Layer1 编辑历史。
  addNode: (node) => set((s) => ({ nodes: [...s.nodes, node] })),
  updateNode: (id, patch) =>
    set((s) => {
      if (!s.nodes.some((n) => n.id === id)) return {}; // 无此节点：不改、不留无谓撤销点
      return {
        editHistory: pushSnapshot(s.editHistory, s.nodes), // 改前先快照（Layer1）
        // 判别联合 + 部分 patch 合并：TS 无法把 spread 结果窄回 CanvasNode union（已知限制），
        // 显式断言回 CanvasNode（非 any，保留判别字段）。
        nodes: s.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as CanvasNode) : n)),
      };
    }),
  deleteNode: (id) =>
    set((s) => {
      if (!s.nodes.some((n) => n.id === id)) return {};
      return {
        editHistory: pushSnapshot(s.editHistory, s.nodes),
        nodes: s.nodes.filter((n) => n.id !== id),
        selectedIds: s.selectedIds.filter((sid) => sid !== id),
      };
    }),
  discardNode: (id) =>
    set((s) => {
      const target = s.nodes.find((n) => n.id === id);
      if (!target) return {};
      // 淘汰即清掉自身 chosen：否则之后该节点若恢复会与已升任主版形成同槽双主版。
      let nodes = s.nodes.map((n) =>
        n.id === id ? { ...n, discarded: true, chosen: false } : n,
      );
      // 淘汰主版时，把同槽最新的活跃版升为主版（保证槽内仍有可定稿主版）。
      if (target.chosen) {
        const key = groupKey(target);
        const promote = nodes
          .filter((n) => n.id !== id && !n.discarded && groupKey(n) === key)
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
        if (promote) nodes = nodes.map((n) => (n.id === promote.id ? { ...n, chosen: true } : n));
      }
      return { nodes, selectedIds: s.selectedIds.filter((sid) => sid !== id) };
    }),
  setChosen: (id) =>
    set((s) => {
      const target = s.nodes.find((n) => n.id === id);
      if (!target) return {};
      const key = groupKey(target); // 同一版本槽 = groupKey(parentId ?? id)
      return {
        nodes: s.nodes.map((n) => {
          if (n.id === id) return { ...n, chosen: true };
          if (groupKey(n) === key) return { ...n, chosen: false };
          return n;
        }),
      };
    }),
  renameNode: (id, label) =>
    set((s) => {
      if (!s.nodes.some((n) => n.id === id)) return {};
      return {
        editHistory: pushSnapshot(s.editHistory, s.nodes),
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, label } : n)),
      };
    }),
  setCamera: (camera) =>
    set((s) => ({
      camera: typeof camera === 'function' ? camera(s.camera) : camera,
    })),
  setSelected: (selectedIds) => set({ selectedIds }),
  setGenerating: (generating) => set({ generating }),
  setError: (error) => set({ error }),
  undoEdit: () => {
    const s = get();
    const res = applyUndo(s.editHistory, s.nodes);
    if (!res) return;
    // 调和还原帧与当前态：保留 Layer2(chosen/discarded)与快照后新增节点（修 HIGH-1）。
    const nodes = reconcileUndoFrame(res.nodes, s.nodes);
    const ids = new Set(nodes.map((node) => node.id));
    set({ nodes, editHistory: res.stack, selectedIds: s.selectedIds.filter((id) => ids.has(id)) });
  },
  redoEdit: () => {
    const s = get();
    const res = applyRedo(s.editHistory, s.nodes);
    if (!res) return;
    const nodes = reconcileUndoFrame(res.nodes, s.nodes);
    const ids = new Set(nodes.map((node) => node.id));
    set({ nodes, editHistory: res.stack, selectedIds: s.selectedIds.filter((id) => ids.has(id)) });
  },
  clearEditHistory: () => set({ editHistory: clearHistory() }),
  canEditUndo: () => canUndo(get().editHistory),
  canEditRedo: () => canRedo(get().editHistory),
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

// E2E/dev 调试钩子：暴露画布 store 供真机交互测试 seed 节点 + 断言 undo/redo 结果。
// 仅 dev 构建注入（import.meta.env.DEV），与 designPreviewInject 的 window.__neo* 钩子同例。
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __neoDesignCanvasStore?: typeof useDesignCanvasStore }).__neoDesignCanvasStore =
    useDesignCanvasStore;
}
