// ADR-026 提议应用引擎：ops→画布状态 + stale-target 防御（纯函数）。
import { describe, it, expect } from 'vitest';
import { computeProposalResult, type ProposalApplyState } from '../../../src/renderer/components/design/applyCanvasProposal';
import type { CanvasNode } from '../../../src/renderer/components/design/designCanvasTypes';
import type { CanvasProposalOp } from '../../../src/shared/contract/canvasProposal';

function node(id: string, x = 0, y = 0): CanvasNode {
  return { id, src: `assets/${id}.png`, x, y, width: 100, height: 100, createdAt: 1 };
}
function emptyState(nodes: CanvasNode[]): ProposalApplyState {
  return { nodes, connectors: [], shapes: [] };
}
const OPTS = { genId: (kind: string, i: number) => `${kind}-${i}`, now: 1000 };

describe('computeProposalResult — moveNode', () => {
  it('目标存在：更新坐标，不动其它节点', () => {
    const state = emptyState([node('a', 1, 1), node('b', 2, 2)]);
    const ops: CanvasProposalOp[] = [{ kind: 'moveNode', nodeId: 'a', x: 50, y: 60 }];
    const r = computeProposalResult(state, ops, OPTS);
    expect(r.next.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 50, y: 60 });
    expect(r.next.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 2, y: 2 });
    expect(r.applied).toEqual([{ index: 0, kind: 'moveNode' }]);
    expect(r.changed).toBe(true);
  });

  it('目标不存在（stale）：跳过 + 记 node-not-found，不改状态', () => {
    const state = emptyState([node('a')]);
    const ops: CanvasProposalOp[] = [{ kind: 'moveNode', nodeId: 'ghost', x: 5, y: 5 }];
    const r = computeProposalResult(state, ops, OPTS);
    expect(r.applied).toHaveLength(0);
    expect(r.skipped).toEqual([{ index: 0, kind: 'moveNode', reason: 'node-not-found' }]);
    expect(r.changed).toBe(false);
    expect(r.next.nodes).toEqual(state.nodes);
  });
});

describe('computeProposalResult — renameNode', () => {
  it('目标存在：写 label', () => {
    const state = emptyState([node('a')]);
    const r = computeProposalResult(state, [{ kind: 'renameNode', nodeId: 'a', label: '登录页' }], OPTS);
    expect(r.next.nodes[0].label).toBe('登录页');
    expect(r.applied).toHaveLength(1);
  });
  it('目标不存在：跳过', () => {
    const r = computeProposalResult(emptyState([node('a')]), [{ kind: 'renameNode', nodeId: 'x', label: 'y' }], OPTS);
    expect(r.skipped[0].reason).toBe('node-not-found');
  });
});

describe('computeProposalResult — addConnector', () => {
  it('两端存在：加连线（分配 id/createdAt）+ 带 label', () => {
    const state = emptyState([node('a'), node('b')]);
    const r = computeProposalResult(state, [{ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b', label: '下一步' }], OPTS);
    expect(r.next.connectors).toHaveLength(1);
    expect(r.next.connectors[0]).toMatchObject({ id: 'connector-0', fromNodeId: 'a', toNodeId: 'b', label: '下一步', createdAt: 1000 });
  });

  it('端点不存在：跳过 node-not-found', () => {
    const state = emptyState([node('a')]);
    const r = computeProposalResult(state, [{ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'ghost' }], OPTS);
    expect(r.skipped[0].reason).toBe('node-not-found');
    expect(r.next.connectors).toHaveLength(0);
  });

  it('同向重复连线：跳过 duplicate-connector', () => {
    const state: ProposalApplyState = {
      nodes: [node('a'), node('b')],
      connectors: [{ id: 'c0', fromNodeId: 'a', toNodeId: 'b', createdAt: 1 }],
      shapes: [],
    };
    const r = computeProposalResult(state, [{ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b' }], OPTS);
    expect(r.skipped[0].reason).toBe('duplicate-connector');
    expect(r.next.connectors).toHaveLength(1);
  });

  it('反向不算重复（a→b 存在时 b→a 仍可加）', () => {
    const state: ProposalApplyState = {
      nodes: [node('a'), node('b')],
      connectors: [{ id: 'c0', fromNodeId: 'a', toNodeId: 'b', createdAt: 1 }],
      shapes: [],
    };
    const r = computeProposalResult(state, [{ kind: 'addConnector', fromNodeId: 'b', toNodeId: 'a' }], OPTS);
    expect(r.applied).toHaveLength(1);
    expect(r.next.connectors).toHaveLength(2);
  });
});

describe('computeProposalResult — addShape', () => {
  it('text 形状：恒应用，分配 id/createdAt + 缺色用默认', () => {
    const r = computeProposalResult(emptyState([]), [{ kind: 'addShape', shape: { kind: 'text', x: 5, y: 6, text: '说明' } }], OPTS);
    expect(r.next.shapes).toHaveLength(1);
    expect(r.next.shapes[0]).toMatchObject({ id: 'shape-0', kind: 'text', x: 5, y: 6, text: '说明', createdAt: 1000 });
    expect((r.next.shapes[0] as { color: string }).color).toBeTruthy();
  });

  it('rect 形状带色：保留色', () => {
    const r = computeProposalResult(emptyState([]), [{ kind: 'addShape', shape: { kind: 'rect', x: 0, y: 0, width: 10, height: 10, color: '#ff0000' } }], OPTS);
    expect(r.next.shapes[0]).toMatchObject({ kind: 'rect', color: '#ff0000' });
  });
});

describe('computeProposalResult — 混合批 + 顺序', () => {
  it('一批含应用与跳过：分别计入，应用顺序保留 index', () => {
    const state = emptyState([node('a'), node('b')]);
    const ops: CanvasProposalOp[] = [
      { kind: 'moveNode', nodeId: 'a', x: 9, y: 9 },          // 应用 0
      { kind: 'moveNode', nodeId: 'ghost', x: 1, y: 1 },      // 跳过 1
      { kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b' }, // 应用 2
      { kind: 'addShape', shape: { kind: 'text', x: 0, y: 0, text: 'n' } }, // 应用 3
    ];
    const r = computeProposalResult(state, ops, OPTS);
    expect(r.applied.map((a) => a.index)).toEqual([0, 2, 3]);
    expect(r.skipped.map((s) => s.index)).toEqual([1]);
    expect(r.next.connectors).toHaveLength(1);
    expect(r.next.shapes).toHaveLength(1);
    expect(r.changed).toBe(true);
  });

  it('全跳过：changed=false，状态不变（引用相等）', () => {
    const state = emptyState([node('a')]);
    const r = computeProposalResult(state, [{ kind: 'moveNode', nodeId: 'x', x: 1, y: 1 }], OPTS);
    expect(r.changed).toBe(false);
    expect(r.next.nodes).toBe(state.nodes);
    expect(r.next.connectors).toBe(state.connectors);
  });
});
