// ADR-026 提议契约：校验/归一化（main 产出与 renderer 消费共用，防破损 op 进流程）。
import { describe, it, expect } from 'vitest';
import {
  normalizeProposalOp,
  normalizeProposedShape,
  normalizeProposal,
  formatCanvasSnapshotForPrompt,
  CANVAS_SNAPSHOT_MAX_NODES,
  MAX_OPS_PER_PROPOSAL,
  PROPOSAL_COLOR_MAX,
  PROPOSAL_TEXT_MAX,
  type CanvasSnapshot,
} from '../../../src/shared/contract/canvasProposal';

describe('normalizeProposalOp', () => {
  it('moveNode：合法通过', () => {
    expect(normalizeProposalOp({ kind: 'moveNode', nodeId: 'n1', x: 10, y: 20 })).toEqual({
      kind: 'moveNode',
      nodeId: 'n1',
      x: 10,
      y: 20,
    });
  });

  it('moveNode：缺坐标/空 id/非有限数 → null', () => {
    expect(normalizeProposalOp({ kind: 'moveNode', nodeId: '', x: 1, y: 2 })).toBeNull();
    expect(normalizeProposalOp({ kind: 'moveNode', nodeId: 'n1', x: NaN, y: 2 })).toBeNull();
    expect(normalizeProposalOp({ kind: 'moveNode', nodeId: 'n1', x: 1 })).toBeNull();
  });

  it('addConnector：合法通过 + label 截断', () => {
    const op = normalizeProposalOp({ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b', label: 'x'.repeat(5000) });
    expect(op).toMatchObject({ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b' });
    expect((op as { label: string }).label.length).toBe(PROPOSAL_TEXT_MAX);
  });

  it('addConnector：自环拒绝', () => {
    expect(normalizeProposalOp({ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'a' })).toBeNull();
  });

  it('renameNode：合法通过 + label 截断', () => {
    const op = normalizeProposalOp({ kind: 'renameNode', nodeId: 'n1', label: 'y'.repeat(5000) });
    expect((op as { label: string }).label.length).toBe(PROPOSAL_TEXT_MAX);
  });

  it('renameNode：空 label → null', () => {
    expect(normalizeProposalOp({ kind: 'renameNode', nodeId: 'n1', label: '' })).toBeNull();
  });

  it('discardNode（三刀软删）：合法通过 + 缺 nodeId → null', () => {
    expect(normalizeProposalOp({ kind: 'discardNode', nodeId: 'n1' })).toEqual({ kind: 'discardNode', nodeId: 'n1' });
    expect(normalizeProposalOp({ kind: 'discardNode', nodeId: '' })).toBeNull();
  });

  it('未知 kind / 非对象 → null（deleteNode 硬删仍不在白名单）', () => {
    expect(normalizeProposalOp({ kind: 'deleteNode', nodeId: 'n1' })).toBeNull();
    expect(normalizeProposalOp(null)).toBeNull();
    expect(normalizeProposalOp('x')).toBeNull();
  });
});

describe('normalizeProposedShape', () => {
  it('rect/ellipse：合法 + 缺色用 undefined（renderer 兜默认）', () => {
    expect(normalizeProposedShape({ kind: 'rect', x: 0, y: 0, width: 10, height: 10 })).toEqual({
      kind: 'rect',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
  });

  it('sticky/text：text 截断', () => {
    const s = normalizeProposedShape({ kind: 'text', x: 1, y: 2, text: 'z'.repeat(5000) });
    expect((s as { text: string }).text.length).toBe(PROPOSAL_TEXT_MAX);
  });

  it('line：points 必须 4 个有限数', () => {
    expect(normalizeProposedShape({ kind: 'line', points: [0, 0, 5, 5] })).toMatchObject({ kind: 'line' });
    expect(normalizeProposedShape({ kind: 'line', points: [0, 0, 5] })).toBeNull();
    expect(normalizeProposedShape({ kind: 'line', points: [0, 0, 5, NaN] })).toBeNull();
  });

  it('缺几何 / 未知 kind → null', () => {
    expect(normalizeProposedShape({ kind: 'rect', x: 0, y: 0 })).toBeNull();
    expect(normalizeProposedShape({ kind: 'blob' })).toBeNull();
  });
});

describe('normalizeProposal', () => {
  it('过滤非法 op 并计 dropped', () => {
    const res = normalizeProposal([
      { kind: 'moveNode', nodeId: 'n1', x: 1, y: 2 },
      { kind: 'deleteNode', nodeId: 'x' }, // 非法（破坏性 op 不在白名单）
      { kind: 'addConnector', fromNodeId: 'a', toNodeId: 'a' }, // 自环
      { kind: 'renameNode', nodeId: 'n2', label: 'hi' },
    ]);
    expect(res.ops).toHaveLength(2);
    expect(res.dropped).toBe(2);
  });

  it('非数组 → 空', () => {
    expect(normalizeProposal('nope')).toEqual({ ops: [], dropped: 0 });
  });

  it('超 MAX_OPS_PER_PROPOSAL：截断，超出计 dropped（防上万 op 撑爆）', () => {
    const many = Array.from({ length: MAX_OPS_PER_PROPOSAL + 25 }, (_, i) => ({ kind: 'renameNode', nodeId: `n${i}`, label: 'x' }));
    const res = normalizeProposal(many);
    expect(res.ops).toHaveLength(MAX_OPS_PER_PROPOSAL);
    expect(res.dropped).toBe(25);
  });
});

describe('normalizeProposedShape color 上限（I4）', () => {
  it('超长 color 截断到 PROPOSAL_COLOR_MAX', () => {
    const s = normalizeProposedShape({ kind: 'rect', x: 0, y: 0, width: 1, height: 1, color: 'a'.repeat(5000) });
    expect((s as { color: string }).color.length).toBe(PROPOSAL_COLOR_MAX);
  });
});

describe('formatCanvasSnapshotForPrompt', () => {
  const snap = (nodes: CanvasSnapshot['nodes'], extra: Partial<CanvasSnapshot> = {}): CanvasSnapshot => ({
    nodes, connectors: [], shapeCount: 0, ...extra,
  });

  it('空画布 → null', () => {
    expect(formatCanvasSnapshotForPrompt(snap([]))).toBeNull();
    expect(formatCanvasSnapshotForPrompt(null)).toBeNull();
    expect(formatCanvasSnapshotForPrompt(undefined)).toBeNull();
  });

  it('列出节点 id/label/坐标，含连线与形状计数', () => {
    const out = formatCanvasSnapshotForPrompt(snap(
      [{ id: 'n1', label: '登录页', x: 0, y: 0, width: 200, height: 400 }],
      { connectors: [{ fromNodeId: 'n1', toNodeId: 'n2', label: '下一步' }], shapeCount: 3 },
    ))!;
    expect(out).toContain('n1');
    expect(out).toContain('登录页');
    expect(out).toContain('n1 → n2');
    expect(out).toContain('下一步');
    expect(out).toContain('3');
    expect(out).toContain('ProposeCanvasOps');
  });

  it('节点超上限：截断并标记', () => {
    const many = Array.from({ length: CANVAS_SNAPSHOT_MAX_NODES + 10 }, (_, i) => ({ id: `n${i}`, x: 0, y: 0, width: 10, height: 10 }));
    const out = formatCanvasSnapshotForPrompt(snap(many))!;
    expect(out).toContain(`仅列前 ${CANVAS_SNAPSHOT_MAX_NODES}`);
    // 只渲染前 MAX 个 id 行
    expect(out).not.toContain(`n${CANVAS_SNAPSHOT_MAX_NODES + 5} `);
  });

  it('连线超上限：标注截断并提示避免重复（I3）', () => {
    const nodes = [{ id: 'a', x: 0, y: 0, width: 10, height: 10 }];
    const conns = Array.from({ length: CANVAS_SNAPSHOT_MAX_NODES + 5 }, (_, i) => ({ fromNodeId: 'a', toNodeId: `b${i}` }));
    const out = formatCanvasSnapshotForPrompt(snap(nodes, { connectors: conns }))!;
    expect(out).toContain(`仅列前 ${CANVAS_SNAPSHOT_MAX_NODES} 条`);
    expect(out).toContain('避免重复');
  });
});
