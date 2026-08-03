import { afterEach, describe, expect, it, vi } from 'vitest';
import { staleMoveNodeIds } from '../../../src/renderer/components/design/canvasProposalApproval';
import { computeProposalResult } from '../../../src/renderer/components/design/applyCanvasProposal';
import { useCanvasProposalStore } from '../../../src/renderer/components/design/canvasProposalStore';
import type { CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';
import type { CanvasOpProposal, CanvasProposalOp } from '../../../src/shared/contract/canvasProposal';

const RECEIVED_AT = 1_000;

const node = (id: string, over: Partial<CanvasImageNode> = {}): CanvasImageNode => ({
  id,
  src: `assets/${id}.png`,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  createdAt: 1,
  createdBy: 'agent',
  ...over,
});

const move = (nodeId: string): CanvasProposalOp => ({ kind: 'moveNode', nodeId, x: 20, y: 30 });

afterEach(() => {
  vi.restoreAllMocks();
  useCanvasProposalStore.getState().clear();
});

describe('staleMoveNodeIds 陈旧检出（userTouchedAt > receivedAt）', () => {
  it('提议到达后用户拖动目标节点 ⇒ 该 op 陈旧；同批未被拖动的 op 不受影响', () => {
    const ops: CanvasProposalOp[] = [move('A'), move('B')];
    const nodes = [
      node('A', { userTouchedAt: RECEIVED_AT + 1 }), // 提议之后被拖
      node('B'), // 从未被用户碰过
    ];
    expect(staleMoveNodeIds(ops, nodes, RECEIVED_AT)).toEqual(new Set(['A']));
  });

  it('提议到达前就有 userTouchedAt（用户早先动过）⇒ 不算陈旧（判据是「提议之后」）', () => {
    const ops: CanvasProposalOp[] = [move('A')];
    const nodes = [node('A', { userTouchedAt: RECEIVED_AT - 1 })];
    expect(staleMoveNodeIds(ops, nodes, RECEIVED_AT)).toEqual(new Set());
  });

  it('userTouchedAt 恰好等于 receivedAt ⇒ 不算陈旧（严格大于）', () => {
    expect(staleMoveNodeIds([move('A')], [node('A', { userTouchedAt: RECEIVED_AT })], RECEIVED_AT)).toEqual(new Set());
  });

  it('非 moveNode op 不参与陈旧判定；目标节点不存在也不判陈旧', () => {
    const ops: CanvasProposalOp[] = [
      { kind: 'renameNode', nodeId: 'A', label: '首页' },
      move('MISSING'),
    ];
    const nodes = [node('A', { userTouchedAt: RECEIVED_AT + 1 })];
    expect(staleMoveNodeIds(ops, nodes, RECEIVED_AT)).toEqual(new Set());
  });
});

describe('canvasProposalStore.receivedAt 到达时间戳（协议零改动）', () => {
  const proposal: CanvasOpProposal = { requestId: 'r1', ops: [move('A')] };

  it('setPending 记录 receivedAt，clear 复位', () => {
    const now = 4_200;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    useCanvasProposalStore.getState().setPending(proposal);
    expect(useCanvasProposalStore.getState().receivedAt).toBe(now);
    useCanvasProposalStore.getState().clear();
    expect(useCanvasProposalStore.getState().receivedAt).toBeNull();
  });
});

describe('落地语义不变', () => {
  it('陈旧 op 被批准后仍落到 op.x/op.y（绝对坐标，不回退用户拖动）', () => {
    const staleNode = node('A', { x: 500, y: 600, userTouchedAt: RECEIVED_AT + 1 });
    const result = computeProposalResult(
      { nodes: [staleNode], connectors: [], shapes: [] },
      [{ kind: 'moveNode', nodeId: 'A', x: 20, y: 30 }],
      { genId: (kind, i) => `${kind}-${i}`, now: 9_999 },
    );
    const landed = result.next.nodes.find((n) => n.id === 'A');
    expect(result.applied).toHaveLength(1);
    expect(landed?.x).toBe(20);
    expect(landed?.y).toBe(30);
  });
});
