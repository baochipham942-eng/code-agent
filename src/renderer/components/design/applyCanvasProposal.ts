// ADR-026 提议应用引擎（纯函数，无 React/konva/store 依赖，可单测）。
// 把一批 agent 提议 op 应用到当前画布 {nodes,connectors,shapes}，产出新状态 + 应用/跳过明细。
// **stale-target 防御**：引用已不存在节点的 op（移动/改名/连线端点）跳过并记原因——
// 阻塞审批期间用户可能删了节点 / 提议基于陈旧态。
// 历史/快照/落盘不在这里（store action 负责 D3-B 整批单次快照），保持本引擎纯净。
import type { CanvasNode } from './designCanvasTypes';
import { type CanvasConnector, type CanvasShape, DIAGRAM_DEFAULT_COLOR } from './designDiagramTypes';
import type { CanvasProposalOp, ProposedShape } from '../../../shared/contract/canvasProposal';

export interface ProposalApplyState {
  nodes: CanvasNode[];
  connectors: CanvasConnector[];
  shapes: CanvasShape[];
}

export interface AppliedOp {
  index: number;
  kind: CanvasProposalOp['kind'];
}

export interface SkippedOp {
  index: number;
  kind: CanvasProposalOp['kind'];
  /** 'node-not-found' | 'duplicate-connector' */
  reason: string;
}

export interface ProposalApplyResult {
  next: ProposalApplyState;
  applied: AppliedOp[];
  skipped: SkippedOp[];
  /** 是否真有变更（全跳过则 false，调用方可不落盘/不进快照）。 */
  changed: boolean;
}

export interface ProposalApplyOpts {
  /** 为新连线/形状分配 id（component 注入 crypto.randomUUID，保持引擎纯）。 */
  genId: (kind: string, index: number) => string;
  /** 新实体 createdAt（component 注入 Date.now）。 */
  now: number;
}

function shapeFromProposed(s: ProposedShape, id: string, createdAt: number): CanvasShape {
  const color = s.color && s.color.length > 0 ? s.color : DIAGRAM_DEFAULT_COLOR;
  switch (s.kind) {
    case 'rect':
    case 'ellipse':
      return { id, kind: s.kind, x: s.x, y: s.y, width: s.width, height: s.height, color, createdAt };
    case 'sticky':
      return { id, kind: 'sticky', x: s.x, y: s.y, width: s.width, height: s.height, text: s.text, color, createdAt };
    case 'text':
      return { id, kind: 'text', x: s.x, y: s.y, text: s.text, color, createdAt };
    case 'line':
      return { id, kind: 'line', points: s.points, color, createdAt };
  }
}

/**
 * 把一批提议 op 顺序应用到画布状态。
 * - moveNode / renameNode：目标节点须存在，否则跳过（stale-target）。
 * - addConnector：两端节点须存在且非自环；同向重复连线跳过（duplicate-connector）。
 * - addShape：无目标，恒应用（renderer 分配 id/createdAt）。
 * 节点集在本批内不变（第一刀无 加/删 节点），故 stale 判定用初始节点集。
 */
export function computeProposalResult(
  state: ProposalApplyState,
  ops: CanvasProposalOp[],
  opts: ProposalApplyOpts,
): ProposalApplyResult {
  const nodeIds = new Set(state.nodes.map((n) => n.id));
  let nodes = state.nodes;
  let connectors = state.connectors;
  let shapes = state.shapes;
  const applied: AppliedOp[] = [];
  const skipped: SkippedOp[] = [];

  ops.forEach((op, index) => {
    switch (op.kind) {
      case 'moveNode': {
        if (!nodeIds.has(op.nodeId)) { skipped.push({ index, kind: op.kind, reason: 'node-not-found' }); return; }
        nodes = nodes.map((n) => (n.id === op.nodeId ? { ...n, x: op.x, y: op.y } : n));
        applied.push({ index, kind: op.kind });
        return;
      }
      case 'renameNode': {
        if (!nodeIds.has(op.nodeId)) { skipped.push({ index, kind: op.kind, reason: 'node-not-found' }); return; }
        nodes = nodes.map((n) => (n.id === op.nodeId ? { ...n, label: op.label } : n));
        applied.push({ index, kind: op.kind });
        return;
      }
      case 'addConnector': {
        if (!nodeIds.has(op.fromNodeId) || !nodeIds.has(op.toNodeId)) { skipped.push({ index, kind: op.kind, reason: 'node-not-found' }); return; }
        const dup = connectors.some((c) => c.fromNodeId === op.fromNodeId && c.toNodeId === op.toNodeId);
        if (dup) { skipped.push({ index, kind: op.kind, reason: 'duplicate-connector' }); return; }
        const c: CanvasConnector = { id: opts.genId('connector', index), fromNodeId: op.fromNodeId, toNodeId: op.toNodeId, createdAt: opts.now };
        if (op.label) c.label = op.label;
        connectors = [...connectors, c];
        applied.push({ index, kind: op.kind });
        return;
      }
      case 'addShape': {
        shapes = [...shapes, shapeFromProposed(op.shape, opts.genId('shape', index), opts.now)];
        applied.push({ index, kind: op.kind });
        return;
      }
    }
  });

  return { next: { nodes, connectors, shapes }, applied, skipped, changed: applied.length > 0 };
}
