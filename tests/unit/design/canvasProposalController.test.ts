// ADR-026 D2-A：Apply/Reject 落地逻辑（依赖注入）。
import { describe, it, expect, vi } from 'vitest';
import { applyProposal, rejectProposal } from '../../../src/renderer/components/design/canvasProposalController';
import type { CanvasOpProposal } from '../../../src/shared/contract/canvasProposal';
import type { ProposalApplyResult } from '../../../src/renderer/components/design/applyCanvasProposal';

const proposal: CanvasOpProposal = {
  requestId: 'cp-1',
  ops: [{ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b' }],
  rationale: '画用户流',
};

function deps(result: ProposalApplyResult, discard: { applied: number; skipped: number } = { applied: 0, skipped: 0 }) {
  return {
    applyBatch: vi.fn(() => result),
    applyDiscards: vi.fn(() => discard),
    save: vi.fn(),
    respond: vi.fn(),
    genId: (k: string, i: number) => `${k}-${i}`,
    now: () => 1000,
  };
}
const nochange: ProposalApplyResult = { next: { nodes: [], connectors: [], shapes: [] }, applied: [], skipped: [], changed: false };

describe('applyProposal', () => {
  it('有变更：落盘 + 回 apply 带 appliedCount/skippedCount', async () => {
    const result: ProposalApplyResult = { next: { nodes: [], connectors: [], shapes: [] }, applied: [{ index: 0, kind: 'addConnector' }], skipped: [], changed: true };
    const d = deps(result);
    await applyProposal(proposal, d);
    expect(d.applyBatch).toHaveBeenCalledWith(proposal.ops, { genId: d.genId, now: 1000 });
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(d.respond).toHaveBeenCalledWith({ requestId: 'cp-1', verdict: 'apply', appliedCount: 1, skippedCount: 0 });
  });

  it('全跳过（changed=false）：不落盘，但仍回 apply（appliedCount=0）', async () => {
    const result: ProposalApplyResult = { next: { nodes: [], connectors: [], shapes: [] }, applied: [], skipped: [{ index: 0, kind: 'addConnector', reason: 'node-not-found' }], changed: false };
    const d = deps(result);
    await applyProposal(proposal, d);
    expect(d.save).not.toHaveBeenCalled();
    expect(d.respond).toHaveBeenCalledWith({ requestId: 'cp-1', verdict: 'apply', appliedCount: 0, skippedCount: 1 });
  });
});

describe('applyProposal 防御纵深（I1）', () => {
  it('IPC 收到的 ops 在 renderer 侧再校验：剥离非法/破坏性 op 后才 applyBatch', async () => {
    const result: ProposalApplyResult = { next: { nodes: [], connectors: [], shapes: [] }, applied: [{ index: 0, kind: 'addConnector' }], skipped: [], changed: true };
    const d = deps(result);
    const dirty: CanvasOpProposal = {
      requestId: 'cp-2',
      ops: [
        { kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b' },
        // 破坏性/破损 op：renderer 侧 normalizeProposal 应剥离
        { kind: 'deleteNode', nodeId: 'a' } as unknown as CanvasOpProposal['ops'][number],
        { kind: 'addConnector', fromNodeId: 'x', toNodeId: 'x' } as CanvasOpProposal['ops'][number], // 自环
      ],
    };
    await applyProposal(dirty, d);
    const passedOps = d.applyBatch.mock.calls[0][0];
    expect(passedOps).toHaveLength(1);
    expect(passedOps[0]).toMatchObject({ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b' });
  });
});

describe('applyProposal 三刀：discard 拆分 + per-op 取舍', () => {
  it('discardNode 走 applyDiscards（不进 Layer1 批），计数合并回 agent', async () => {
    const d = deps(nochange, { applied: 1, skipped: 0 });
    const p: CanvasOpProposal = { requestId: 'cp-3', ops: [{ kind: 'discardNode', nodeId: 'a' }] };
    const out = await applyProposal(p, d);
    // Layer1 批只收到非 discard op（这里空）
    expect(d.applyBatch.mock.calls[0][0]).toHaveLength(0);
    expect(d.applyDiscards).toHaveBeenCalledWith(['a']);
    expect(d.save).toHaveBeenCalledTimes(1); // discard.applied>0 → 落盘
    expect(out).toMatchObject({ appliedCount: 1, skippedCount: 0 });
    expect(d.respond).toHaveBeenCalledWith({ requestId: 'cp-3', verdict: 'apply', appliedCount: 1, skippedCount: 0 });
  });

  it('混合批：Layer1 进 applyBatch、discard 进 applyDiscards，计数相加', async () => {
    const result: ProposalApplyResult = { next: { nodes: [], connectors: [], shapes: [] }, applied: [{ index: 0, kind: 'moveNode' }], skipped: [], changed: true };
    const d = deps(result, { applied: 1, skipped: 1 });
    const p: CanvasOpProposal = {
      requestId: 'cp-4',
      ops: [{ kind: 'moveNode', nodeId: 'a', x: 1, y: 2 }, { kind: 'discardNode', nodeId: 'b' }, { kind: 'discardNode', nodeId: 'gone' }],
    };
    const out = await applyProposal(p, d);
    expect(d.applyBatch.mock.calls[0][0]).toHaveLength(1); // 只 moveNode
    expect(d.applyDiscards).toHaveBeenCalledWith(['b', 'gone']);
    expect(out).toMatchObject({ appliedCount: 2, skippedCount: 1 });
  });

  it('per-op 取舍：只应用 selectedOps 子集', async () => {
    const result: ProposalApplyResult = { next: { nodes: [], connectors: [], shapes: [] }, applied: [{ index: 0, kind: 'addConnector' }], skipped: [], changed: true };
    const d = deps(result);
    const p: CanvasOpProposal = {
      requestId: 'cp-5',
      ops: [{ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b' }, { kind: 'renameNode', nodeId: 'c', label: 'x' }],
    };
    // 只选第一条
    await applyProposal(p, d, [p.ops[0]]);
    expect(d.applyBatch.mock.calls[0][0]).toHaveLength(1);
    expect(d.applyBatch.mock.calls[0][0][0]).toMatchObject({ kind: 'addConnector' });
  });

  it('全跳过（Layer1 无变更 + discard 全 stale）：不落盘，仍回 apply（appliedCount=0）', async () => {
    const d = deps(nochange, { applied: 0, skipped: 2 });
    const p: CanvasOpProposal = { requestId: 'cp-6', ops: [{ kind: 'discardNode', nodeId: 'x' }, { kind: 'discardNode', nodeId: 'y' }] };
    await applyProposal(p, d);
    expect(d.save).not.toHaveBeenCalled();
    expect(d.respond).toHaveBeenCalledWith({ requestId: 'cp-6', verdict: 'apply', appliedCount: 0, skippedCount: 2 });
  });
});

describe('rejectProposal', () => {
  it('回 reject 带 feedback', async () => {
    const respond = vi.fn();
    await rejectProposal(proposal, { respond }, '  连错了  ');
    expect(respond).toHaveBeenCalledWith({ requestId: 'cp-1', verdict: 'reject', feedback: '连错了' });
  });

  it('空 feedback：不带该字段', async () => {
    const respond = vi.fn();
    await rejectProposal(proposal, { respond }, '   ');
    expect(respond).toHaveBeenCalledWith({ requestId: 'cp-1', verdict: 'reject' });
  });
});
