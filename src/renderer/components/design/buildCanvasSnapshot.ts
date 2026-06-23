// ADR-026 D1-B：从画布运行态构建注入 agent 的轻量快照（纯函数，可单测）。
// 排除已淘汰(discarded)节点（agent 不该对已弃稿提议）；节点超上限截断并标记。
import type { CanvasNode } from './designCanvasTypes';
import type { CanvasConnector, CanvasShape } from './designDiagramTypes';
import {
  CANVAS_SNAPSHOT_MAX_NODES,
  type CanvasSnapshot,
  type CanvasSnapshotNode,
} from '../../../shared/contract/canvasProposal';

export function buildCanvasSnapshot(state: {
  nodes: CanvasNode[];
  connectors: CanvasConnector[];
  shapes: CanvasShape[];
}): CanvasSnapshot {
  const live = state.nodes.filter((n) => !n.discarded);
  const truncated = live.length > CANVAS_SNAPSHOT_MAX_NODES;
  const nodes: CanvasSnapshotNode[] = live.slice(0, CANVAS_SNAPSHOT_MAX_NODES).map((n) => {
    const label = n.label?.trim() || n.prompt?.trim();
    const out: CanvasSnapshotNode = { id: n.id, x: n.x, y: n.y, width: n.width, height: n.height };
    if (label) out.label = label;
    if (n.kind === 'video') out.kind = 'video';
    if (n.chosen) out.chosen = true; // ADR-027 D5：回灌人挑的主版给 agent
    return out;
  });
  // 只保留两端都在快照节点集内的连线（截断后端点可能落选）。
  const ids = new Set(nodes.map((n) => n.id));
  const connectors = state.connectors
    .filter((c) => ids.has(c.fromNodeId) && ids.has(c.toNodeId))
    .map((c) => ({ fromNodeId: c.fromNodeId, toNodeId: c.toNodeId, ...(c.label ? { label: c.label } : {}) }));
  return { nodes, connectors, shapeCount: state.shapes.length, ...(truncated ? { truncated: true } : {}) };
}
