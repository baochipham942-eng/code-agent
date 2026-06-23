// ADR-026 提议契约：校验/归一化（main 产出与 renderer 消费共用，防破损 op 进流程）。
import { describe, it, expect } from 'vitest';
import {
  normalizeProposalOp,
  normalizeProposedShape,
  normalizeProposal,
  PROPOSAL_TEXT_MAX,
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

  it('未知 kind / 非对象 → null', () => {
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
});
