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
import {
  pruneDanglingConnectors,
  type CanvasConnector,
  type CanvasShape,
} from './designDiagramTypes';
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
  reconcileRedoFrame,
  type CanvasEditSnapshot,
  type EditHistoryStack,
} from './canvasEditHistory';

/** 图解层选中引用（形状或连线，统一一个字段，互斥于节点选择）。 */
export type SelectedDiagram = { type: 'shape' | 'connector'; id: string } | null;

interface DesignCanvasState {
  /** 当前画布所属 run 目录（决定存档落点）；null=尚无生成的临时画布。 */
  runDir: string | null;
  nodes: CanvasNode[];
  /** 图解层连线（节点↔节点，渲染时实时算锚点）。 */
  connectors: CanvasConnector[];
  /** 图解层 freeform 形状。 */
  shapes: CanvasShape[];
  camera: CanvasCamera;
  selectedIds: string[];
  /** 图解层选中（形状/连线），与节点选择互斥。 */
  selectedDiagram: SelectedDiagram;
  /** 出图进行中（驱动生成按钮 spinner）。 */
  generating: boolean;
  error: string | null;
  /** Layer1 编辑历史栈：节点移动/缩放/删除/重命名 + 图解层增删改的快照。生成产物走 Layer2 variant spine，不进本栈。 */
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
  // —— 图解层（连线 / 形状），均为 Layer1 直接编辑，进编辑历史 ——
  addConnector: (connector: CanvasConnector) => void;
  updateConnector: (id: string, patch: Partial<Omit<CanvasConnector, 'id'>>) => void;
  deleteConnector: (id: string) => void;
  addShape: (shape: CanvasShape) => void;
  updateShape: (id: string, patch: Partial<CanvasShape>) => void;
  deleteShape: (id: string) => void;
  setSelectedDiagram: (sel: SelectedDiagram) => void;
  setCamera: (camera: CanvasCamera) => void;
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

/** 从当前 state 取一帧编辑快照（节点 + 图解层）。 */
function snapshotOf(s: { nodes: CanvasNode[]; connectors: CanvasConnector[]; shapes: CanvasShape[] }): CanvasEditSnapshot {
  return { nodes: s.nodes, connectors: s.connectors, shapes: s.shapes };
}

export const useDesignCanvasStore = create<DesignCanvasState>()(
  persist(
    (set, get) => ({
  runDir: null,
  nodes: [],
  connectors: [],
  shapes: [],
  camera: { ...emptyCanvasDoc().camera },
  selectedIds: [],
  selectedDiagram: null,
  generating: false,
  error: null,
  editHistory: emptyEditHistory(),

  loadDoc: (runDir, doc) =>
    set({
      runDir,
      nodes: doc.nodes,
      connectors: doc.connectors ?? [],
      shapes: doc.shapes ?? [],
      camera: doc.camera,
      selectedIds: [],
      selectedDiagram: null,
      editHistory: clearHistory(),
    }),
  resetCanvas: () => {
    const empty = emptyCanvasDoc();
    set({
      nodes: empty.nodes,
      connectors: [],
      shapes: [],
      camera: empty.camera,
      selectedIds: [],
      selectedDiagram: null,
      editHistory: clearHistory(),
    });
  },
  // addNode = 生成产物落画布，属 Layer2（variant spine），不进 Layer1 编辑历史。
  // 但它改了节点集，是一条新分支：清空 redo 栈（标准 undo/redo 不变式），
  // 否则 add 后 redo 会带着"当前态独有的新增节点"撞上 reconcileRedoFrame 的不追加语义而丢节点（修 HIGH-1 配套）。
  addNode: (node) =>
    set((s) => ({ nodes: [...s.nodes, node], editHistory: { ...s.editHistory, future: [] } })),
  updateNode: (id, patch) =>
    set((s) => {
      if (!s.nodes.some((n) => n.id === id)) return {}; // 无此节点：不改、不留无谓撤销点
      return {
        editHistory: pushSnapshot(s.editHistory, snapshotOf(s)), // 改前先快照（Layer1）
        // 判别联合 + 部分 patch 合并：TS 无法把 spread 结果窄回 CanvasNode union（已知限制），
        // 显式断言回 CanvasNode（非 any，保留判别字段）。
        nodes: s.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as CanvasNode) : n)),
      };
    }),
  deleteNode: (id) =>
    set((s) => {
      if (!s.nodes.some((n) => n.id === id)) return {};
      const nodes = s.nodes.filter((n) => n.id !== id);
      const nodeIds = new Set(nodes.map((n) => n.id));
      return {
        editHistory: pushSnapshot(s.editHistory, snapshotOf(s)),
        nodes,
        // 级联剪掉指向被删节点的悬空连线（与渲染层过滤一致，保持 state 干净）。
        connectors: pruneDanglingConnectors(s.connectors, nodeIds),
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
        editHistory: pushSnapshot(s.editHistory, snapshotOf(s)),
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, label } : n)),
      };
    }),
  addConnector: (connector) =>
    set((s) => {
      // 端点必须都是现存节点（防加悬空连线）；重复 id 忽略。
      const nodeIds = new Set(s.nodes.map((n) => n.id));
      if (!nodeIds.has(connector.fromNodeId) || !nodeIds.has(connector.toNodeId)) return {};
      if (connector.fromNodeId === connector.toNodeId) return {};
      if (s.connectors.some((c) => c.id === connector.id)) return {};
      return {
        editHistory: pushSnapshot(s.editHistory, snapshotOf(s)),
        connectors: [...s.connectors, connector],
      };
    }),
  updateConnector: (id, patch) =>
    set((s) => {
      if (!s.connectors.some((c) => c.id === id)) return {};
      return {
        editHistory: pushSnapshot(s.editHistory, snapshotOf(s)),
        // 保 id + 端点不被 patch 越权改写（端点改写可绕过 normalizeConnector 制造自环/悬空，修 skeptic LOW-1）。
        connectors: s.connectors.map((c) =>
          c.id === id ? { ...c, ...patch, id: c.id, fromNodeId: c.fromNodeId, toNodeId: c.toNodeId } : c,
        ),
      };
    }),
  deleteConnector: (id) =>
    set((s) => {
      if (!s.connectors.some((c) => c.id === id)) return {};
      return {
        editHistory: pushSnapshot(s.editHistory, snapshotOf(s)),
        connectors: s.connectors.filter((c) => c.id !== id),
        selectedDiagram:
          s.selectedDiagram?.type === 'connector' && s.selectedDiagram.id === id ? null : s.selectedDiagram,
      };
    }),
  addShape: (shape) =>
    set((s) => {
      if (s.shapes.some((sh) => sh.id === shape.id)) return {};
      return {
        editHistory: pushSnapshot(s.editHistory, snapshotOf(s)),
        shapes: [...s.shapes, shape],
      };
    }),
  updateShape: (id, patch) =>
    set((s) => {
      if (!s.shapes.some((sh) => sh.id === id)) return {};
      return {
        editHistory: pushSnapshot(s.editHistory, snapshotOf(s)),
        // 保 id + kind 不被 patch 改写（kind 是判别字段，越权改写会破坏联合）。
        shapes: s.shapes.map((sh) => (sh.id === id ? ({ ...sh, ...patch, id: sh.id, kind: sh.kind } as CanvasShape) : sh)),
      };
    }),
  deleteShape: (id) =>
    set((s) => {
      if (!s.shapes.some((sh) => sh.id === id)) return {};
      return {
        editHistory: pushSnapshot(s.editHistory, snapshotOf(s)),
        shapes: s.shapes.filter((sh) => sh.id !== id),
        selectedDiagram:
          s.selectedDiagram?.type === 'shape' && s.selectedDiagram.id === id ? null : s.selectedDiagram,
      };
    }),
  setSelectedDiagram: (sel) =>
    // 选中图解对象时清掉节点选择（互斥），反之亦然由 setSelected 处理。
    set(() => ({ selectedDiagram: sel, selectedIds: [] })),
  setCamera: (camera) => set({ camera }),
  setSelected: (selectedIds) => set({ selectedIds, selectedDiagram: null }),
  setGenerating: (generating) => set({ generating }),
  setError: (error) => set({ error }),
  undoEdit: () => {
    const s = get();
    const res = applyUndo(s.editHistory, snapshotOf(s));
    if (!res) return;
    // 调和还原帧与当前态：保留 Layer2(chosen/discarded)与快照后新增节点（修 HIGH-1）；
    // connectors/shapes 整帧还原。
    const merged = reconcileUndoFrame(res.snapshot, snapshotOf(s));
    const nodeIds = new Set(merged.nodes.map((node) => node.id));
    set({
      nodes: merged.nodes,
      connectors: pruneDanglingConnectors(merged.connectors, nodeIds),
      shapes: merged.shapes,
      editHistory: res.stack,
      selectedIds: s.selectedIds.filter((id) => nodeIds.has(id)),
      selectedDiagram: null,
    });
  },
  redoEdit: () => {
    const s = get();
    const res = applyRedo(s.editHistory, snapshotOf(s));
    if (!res) return;
    // redo 用 redo 专用调和（不追加 current-only 节点，修 skeptic HIGH-1）。
    const merged = reconcileRedoFrame(res.snapshot, snapshotOf(s));
    const nodeIds = new Set(merged.nodes.map((node) => node.id));
    set({
      nodes: merged.nodes,
      connectors: pruneDanglingConnectors(merged.connectors, nodeIds),
      shapes: merged.shapes,
      editHistory: res.stack,
      selectedIds: s.selectedIds.filter((id) => nodeIds.has(id)),
      selectedDiagram: null,
    });
  },
  clearEditHistory: () => set({ editHistory: clearHistory() }),
  canEditUndo: () => canUndo(get().editHistory),
  canEditRedo: () => canRedo(get().editHistory),
  toDoc: () => {
    const s = get();
    const doc: DesignCanvasDoc = { version: 1, nodes: s.nodes, camera: s.camera };
    if (s.connectors.length > 0) doc.connectors = s.connectors;
    if (s.shapes.length > 0) doc.shapes = s.shapes;
    return doc;
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
