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

function deps(result: ProposalApplyResult) {
  return {
    applyBatch: vi.fn(() => result),
    save: vi.fn(),
    respond: vi.fn(),
    genId: (k: string, i: number) => `${k}-${i}`,
    now: () => 1000,
  };
}

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
