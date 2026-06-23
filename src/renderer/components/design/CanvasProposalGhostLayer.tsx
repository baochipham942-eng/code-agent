// ADR-026 D2-A：把待审批提议画成画布上的「幽灵」虚影（虚线/半透明），让用户所见即所得。
// 纯展示（react-konva），不改 store；坐标取自当前节点（stale 目标自动跳过不画）。
import React from 'react';
import { Group, Line, Rect, Ellipse, Text as KonvaText } from 'react-konva';
import type { CanvasNode } from './designCanvasTypes';
import type { CanvasProposalOp } from '../../../shared/contract/canvasProposal';

const GHOST = '#3b82f6'; // ds-allow:viz 提议蓝
const GHOST_FILL = 'rgba(59,130,246,0.12)'; // ds-allow:viz
const DANGER = '#ef4444'; // ds-allow:viz 待淘汰红
const DANGER_FILL = 'rgba(239,68,68,0.10)'; // ds-allow:viz

function centerOf(n: CanvasNode): { x: number; y: number } {
  return { x: n.x + n.width / 2, y: n.y + n.height / 2 };
}

export const CanvasProposalGhostLayer: React.FC<{
  ops: CanvasProposalOp[];
  nodes: CanvasNode[];
}> = ({ ops, nodes }) => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <Group listening={false} opacity={0.9}>
      {ops.map((op, i) => {
        switch (op.kind) {
          case 'moveNode': {
            const n = byId.get(op.nodeId);
            if (!n) return null;
            const from = centerOf(n);
            return (
              <Group key={i}>
                {/* 目标位置的虚线框 */}
                <Rect x={op.x} y={op.y} width={n.width} height={n.height} stroke={GHOST} strokeWidth={2} dash={[8, 6]} fill={GHOST_FILL} cornerRadius={4} />
                {/* 从原位到目标的引导线 */}
                <Line points={[from.x, from.y, op.x + n.width / 2, op.y + n.height / 2]} stroke={GHOST} strokeWidth={1.5} dash={[4, 4]} />
              </Group>
            );
          }
          case 'addConnector': {
            const a = byId.get(op.fromNodeId);
            const b = byId.get(op.toNodeId);
            if (!a || !b) return null;
            const pa = centerOf(a);
            const pb = centerOf(b);
            return (
              <Group key={i}>
                <Line points={[pa.x, pa.y, pb.x, pb.y]} stroke={GHOST} strokeWidth={2.5} dash={[10, 6]} />
                {op.label ? <KonvaText x={(pa.x + pb.x) / 2} y={(pa.y + pb.y) / 2 - 14} text={op.label} fontSize={13} fill={GHOST} /> : null}
              </Group>
            );
          }
          case 'addShape': {
            const s = op.shape;
            if (s.kind === 'rect' || s.kind === 'sticky') return <Rect key={i} x={s.x} y={s.y} width={s.width} height={s.height} stroke={GHOST} strokeWidth={2} dash={[8, 6]} fill={GHOST_FILL} />;
            if (s.kind === 'ellipse') return <Ellipse key={i} x={s.x + s.width / 2} y={s.y + s.height / 2} radiusX={Math.abs(s.width) / 2} radiusY={Math.abs(s.height) / 2} stroke={GHOST} strokeWidth={2} dash={[8, 6]} fill={GHOST_FILL} />;
            if (s.kind === 'text') return <KonvaText key={i} x={s.x} y={s.y} text={s.text || '文字'} fontSize={16} fill={GHOST} opacity={0.85} />;
            if (s.kind === 'line') return <Line key={i} points={s.points} stroke={GHOST} strokeWidth={2.5} dash={[10, 6]} />;
            return null;
          }
          case 'renameNode': {
            const n = byId.get(op.nodeId);
            if (!n) return null;
            return <KonvaText key={i} x={n.x} y={n.y - 18} text={`✎ ${op.label}`} fontSize={13} fill={GHOST} />;
          }
          case 'discardNode': {
            const n = byId.get(op.nodeId);
            if (!n) return null;
            // 待淘汰：红框 + 对角叉，明示「这个会被软删（可恢复）」。
            return (
              <Group key={i}>
                <Rect x={n.x} y={n.y} width={n.width} height={n.height} stroke={DANGER} strokeWidth={2} dash={[8, 6]} fill={DANGER_FILL} cornerRadius={4} />
                <Line points={[n.x, n.y, n.x + n.width, n.y + n.height]} stroke={DANGER} strokeWidth={1.5} dash={[4, 4]} />
                <Line points={[n.x + n.width, n.y, n.x, n.y + n.height]} stroke={DANGER} strokeWidth={1.5} dash={[4, 4]} />
              </Group>
            );
          }
          default:
            return null;
        }
      })}
    </Group>
  );
};
