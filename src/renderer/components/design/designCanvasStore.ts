// 设计画布运行态 store（Cowart 式无限画布）。
// 真理源是磁盘 canvas.json（见 designCanvasPersistence），本 store 只持运行态，
// 不挂 persist——避免与磁盘存档双源（详见 内部文档 §2.2）。
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
  computeProposalResult,
  type ProposalApplyResult,
  type ProposalApplyOpts,
} from './applyCanvasProposal';
import type { CanvasProposalOp } from '../../../shared/contract/canvasProposal';
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
  /**
   * 画布属主会话 id（跨会话隔离闸的真理源）；null=无属主（fail-closed）。
   * 全局单例 store 不随 switchSession 重载，故注入闸严格校验属主==当前会话，
   * 防止把会话 A 的画布误注入会话 B 的 agent 上下文。运行态，不持久化（刷新后回 null）。
   */
  ownerSessionId: string | null;
  /** 标记为设计会话的 session（画布快照注入上下文的闸门真源，仅运行时内存态，不进 DB）。 */
  designActiveSessions: Set<string>;
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
  /**
   * 入口认领画布属主：属主已是该会话则 no-op（保留现有画布）；否则重置画布为空并改属主
   * （避免认领后旧内容残留导致下一轮注入泄漏）。
   */
  claimCanvasForSession: (sessionId: string) => void;
  /** 释放画布属主（会话删除/归档时调用）：属主匹配则重置画布为空且属主置 null，否则不动。 */
  clearCanvasOwner: (sessionId: string) => void;
  /** 标记某会话为设计激活（幂等 add）。 */
  markSessionDesignActive: (sessionId: string) => void;
  /** 清除某会话的设计激活标记（幂等 delete）。 */
  clearSessionDesignActive: (sessionId: string) => void;
  /** 查询某会话是否设计激活（null 安全）。 */
  isSessionDesignActive: (sessionId: string | null | undefined) => boolean;
  /** 会话删除/归档时一次性释放其设计态（design-active 标记 + 画布属主），避免悬空。 */
  releaseSessionDesignState: (sessionId: string) => void;
  /** 清空到空画布（保留 runDir）。 */
  resetCanvas: () => void;
  addNode: (node: CanvasNode) => void;
  updateNode: (id: string, patch: Partial<Omit<CanvasNode, 'id'>>) => void;
  deleteNode: (id: string) => void;
  deleteNodes: (ids: readonly string[]) => void;
  /** 淘汰（软删除）：标记 discarded，节点落盘保留；若淘汰的是主版，自动把同槽最新活跃版升为主版。 */
  discardNode: (id: string) => void;
  /** 恢复（取消淘汰）：清掉 discarded 标记让节点重新可见（软删的找回路径，三刀）。 */
  restoreNode: (id: string) => void;
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
  /**
   * 应用一批 agent 提议 op（ADR-026 D3-B：整批=一个原子撤销单元）。
   * 第一刀仅 Layer1 op（移动/连线/形状/标注）：有变更则**整批单次快照**后落新态，
   * 一次 undo 即可全撤；全跳过（stale-target）则不动状态/不进快照。返回应用/跳过明细。
   * 落盘（saveCanvasDoc）由调用方在本 action 后执行。
   */
  applyProposalBatch: (ops: CanvasProposalOp[], opts: ProposalApplyOpts) => ProposalApplyResult;
  setSelectedDiagram: (sel: SelectedDiagram) => void;
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

/** 从当前 state 取一帧编辑快照（节点 + 图解层）。 */
function snapshotOf(s: { nodes: CanvasNode[]; connectors: CanvasConnector[]; shapes: CanvasShape[] }): CanvasEditSnapshot {
  return { nodes: s.nodes, connectors: s.connectors, shapes: s.shapes };
}

/**
 * persist partialize（M1-R2.a）：只持久化 runDir + ownerSessionId；节点/相机从磁盘 canvas.json 恢复。
 * 持久化属主使刷新后属主随 runDir 一起恢复，同会话回来 claim 命中 no-op 保画布，
 * 避免 owner=null 走重置分支把刚从盘恢复的画布清空孤儿化。抽成具名纯函数便于单测。
 */
export function persistDesignCanvas(s: DesignCanvasState) {
  return { runDir: s.runDir, ownerSessionId: s.ownerSessionId };
}

export const useDesignCanvasStore = create<DesignCanvasState>()(
  persist(
    (set, get) => ({
  runDir: null,
  ownerSessionId: null,
  designActiveSessions: new Set<string>(),
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
    // 注意：不写 ownerSessionId（保持现值）——loadDoc 是同属主会话内的存档恢复，不该改属主。
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
  claimCanvasForSession: (sessionId) => {
    const owner = get().ownerSessionId;
    if (owner === sessionId) return; // ① 已属本会话：保留现有画布（no-op）
    if (owner === null) {
      // ② 无主画布（含刷新后从磁盘恢复但 owner 未持久化的边界）→ **认领**现有画布，
      // 保留 nodes/runDir/connectors/shapes，不重置（M1-R2.b：无主画布归当前点击者，不丢数据）。
      set({ ownerSessionId: sessionId });
      return;
    }
    // ③ 真·跨会话（owner 是另一个非空会话）：重置画布为空再换属主（复用 loadDoc 的清空字段集）。
    // 跨会话前的落盘由调用方在 claim 前完成（避免在同步 action 里塞磁盘 I/O，沿用本仓「编辑后落盘」分工）。
    set({
      nodes: [],
      connectors: [],
      shapes: [],
      runDir: null,
      ownerSessionId: sessionId,
      selectedIds: [],
      selectedDiagram: null,
      // L2-R2：清运行态，避免新画布继承上个会话的出图遮罩/错误。
      generating: false,
      error: null,
      editHistory: clearHistory(),
    });
  },
  clearCanvasOwner: (sessionId) => {
    if (get().ownerSessionId !== sessionId) return; // 非属主：不动
    set({
      nodes: [],
      connectors: [],
      shapes: [],
      runDir: null,
      ownerSessionId: null,
      selectedIds: [],
      selectedDiagram: null,
      editHistory: clearHistory(),
    });
  },
  markSessionDesignActive: (sessionId) => {
    set((state) => {
      if (state.designActiveSessions.has(sessionId)) return state;
      return { designActiveSessions: new Set(state.designActiveSessions).add(sessionId) };
    });
  },
  clearSessionDesignActive: (sessionId) => {
    set((state) => {
      if (!state.designActiveSessions.has(sessionId)) return state;
      const next = new Set(state.designActiveSessions);
      next.delete(sessionId);
      return { designActiveSessions: next };
    });
  },
  isSessionDesignActive: (sessionId) => {
    if (!sessionId) return false;
    return get().designActiveSessions.has(sessionId);
  },
  releaseSessionDesignState: (sessionId) => {
    get().clearSessionDesignActive(sessionId);
    get().clearCanvasOwner(sessionId);
  },
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
  deleteNode: (id) => get().deleteNodes([id]),
  deleteNodes: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      if (idSet.size === 0 || !s.nodes.some((n) => idSet.has(n.id))) return {};
      const nodes = s.nodes.filter((n) => !idSet.has(n.id));
      const nodeIds = new Set(nodes.map((n) => n.id));
      return {
        editHistory: pushSnapshot(s.editHistory, snapshotOf(s)),
        nodes,
        // 级联剪掉指向被删节点的悬空连线（与渲染层过滤一致，保持 state 干净）。
        connectors: pruneDanglingConnectors(s.connectors, nodeIds),
        selectedIds: s.selectedIds.filter((sid) => !idSet.has(sid)),
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
  restoreNode: (id) =>
    set((s) => {
      const target = s.nodes.find((n) => n.id === id);
      if (!target?.discarded) return {}; // 不存在或本就没淘汰：no-op
      // 清 discarded。若同槽已无主版（如整槽淘汰后逐个恢复），把本节点升为主版补回
      // 「槽内恒有一个 chosen」不变量（M1，对称于 discardNode 的自动升主版）；否则留 false。
      const key = groupKey(target);
      const slotHasChosen = s.nodes.some(
        (n) => n.id !== id && !n.discarded && groupKey(n) === key && n.chosen,
      );
      const chosen = !slotHasChosen;
      return { nodes: s.nodes.map((n) => (n.id === id ? { ...n, discarded: false, chosen } : n)) };
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
  applyProposalBatch: (ops, opts) => {
    // 用 set((s)=>...) 更新式，基于最新态原子计算+落定（防 get()→set() 间并发漂移，
    // 如审批期间用户拖动节点；与本 store 其它 action 一致）。结果经闭包带出。
    let result!: ProposalApplyResult;
    set((s) => {
      result = computeProposalResult({ nodes: s.nodes, connectors: s.connectors, shapes: s.shapes }, ops, opts);
      if (!result.changed) return {};
      // D3-B：Layer1 整批单次快照（应用前），整批一次 undo 撤完。
      return {
        editHistory: pushSnapshot(s.editHistory, snapshotOf(s)),
        nodes: result.next.nodes,
        connectors: result.next.connectors,
        shapes: result.next.shapes,
      };
    });
    return result;
  },
  setSelectedDiagram: (sel) =>
    // 选中图解对象时清掉节点选择（互斥），反之亦然由 setSelected 处理。
    set(() => ({ selectedDiagram: sel, selectedIds: [] })),
  setCamera: (camera) =>
    set((s) => ({
      camera: typeof camera === 'function' ? camera(s.camera) : camera,
    })),
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
      // 持久化 runDir（画布所属 run）+ ownerSessionId（属主，M1-R2.a）；节点/相机从磁盘 canvas.json 恢复。
      partialize: persistDesignCanvas,
    },
  ),
);

// E2E/dev 调试钩子：暴露画布 store 供真机交互测试 seed 节点 + 断言 undo/redo 结果。
// 仅 dev 构建注入（import.meta.env.DEV），与 designPreviewInject 的 window.__neo* 钩子同例。
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __neoDesignCanvasStore?: typeof useDesignCanvasStore }).__neoDesignCanvasStore =
    useDesignCanvasStore;
}
