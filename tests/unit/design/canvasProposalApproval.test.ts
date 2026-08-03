import { describe, expect, it } from 'vitest';
import { splitCanvasProposalOps } from '../../../src/renderer/components/design/canvasProposalApproval';
import type { CanvasImageNode } from '../../../src/renderer/components/design/designCanvasTypes';
import type { CanvasProposalOp } from '../../../src/shared/contract';

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

describe('splitCanvasProposalOps 分级免审批', () => {
  it('新增连线/形状直接落地', () => {
    const ops: CanvasProposalOp[] = [
      { kind: 'addConnector', fromNodeId: 'A', toNodeId: 'B' },
      { kind: 'addShape', shape: { kind: 'text', x: 1, y: 2, text: '说明' } },
    ];
    const split = splitCanvasProposalOps(ops, [node('A'), node('B')]);
    expect(split.directOps).toEqual(ops);
    expect(split.approvalOps).toEqual([]);
  });

  it('移动 agent 自建且未 userTouched 的节点直接落地', () => {
    const op: CanvasProposalOp = { kind: 'moveNode', nodeId: 'A', x: 20, y: 30 };
    expect(splitCanvasProposalOps([op], [node('A')]).directOps).toEqual([op]);
  });

  it('修改 agent 自建且未 userTouched 的内容直接落地', () => {
    const op: CanvasProposalOp = { kind: 'renameNode', nodeId: 'A', label: '首页' };
    expect(splitCanvasProposalOps([op], [node('A')]).directOps).toEqual([op]);
  });

  it('用户创建或 userTouched 的节点修改继续审批，并标记专用文案原因', () => {
    const ops: CanvasProposalOp[] = [
      { kind: 'moveNode', nodeId: 'A', x: 20, y: 30 },
      { kind: 'renameNode', nodeId: 'B', label: '结算' },
    ];
    const split = splitCanvasProposalOps(ops, [
      node('A', { userTouchedAt: 10 }),
      node('B', { createdBy: 'user', userTouchedAt: 11 }),
    ]);
    expect(split.approvalOps).toEqual(ops);
    expect(split.approvalReason).toBe('user-touched');
  });

  it('删除任何实体与付费生成继续审批', () => {
    const ops: CanvasProposalOp[] = [
      { kind: 'discardNode', nodeId: 'A' },
      { kind: 'generateImage', prompt: '首页' },
    ];
    const split = splitCanvasProposalOps(ops, [node('A')]);
    expect(split.directOps).toEqual([]);
    expect(split.approvalOps).toEqual(ops);
  });

  it('混合批次拆成免批部分与审批部分，不因含新增整批放行', () => {
    const add: CanvasProposalOp = { kind: 'addShape', shape: { kind: 'rect', x: 0, y: 0, width: 10, height: 10 } };
    const remove: CanvasProposalOp = { kind: 'discardNode', nodeId: 'A' };
    const split = splitCanvasProposalOps([add, remove], [node('A')]);
    expect(split.directOps).toEqual([add]);
    expect(split.approvalOps).toEqual([remove]);
  });
});
