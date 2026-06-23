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

  it('L1：用户取消勾选的 op 计入 skippedCount（让 agent 知被否决，勿重提）', async () => {
    const result: ProposalApplyResult = { next: { nodes: [], connectors: [], shapes: [] }, applied: [{ index: 0, kind: 'addConnector' }], skipped: [], changed: true };
    const d = deps(result);
    const p: CanvasOpProposal = {
      requestId: 'cp-7',
      ops: [{ kind: 'addConnector', fromNodeId: 'a', toNodeId: 'b' }, { kind: 'renameNode', nodeId: 'c', label: 'x' }, { kind: 'renameNode', nodeId: 'd', label: 'y' }],
    };
    // 3 选 1：另 2 条算 deselected → skippedCount=2
    const out = await applyProposal(p, d, [p.ops[0]]);
    expect(out).toMatchObject({ appliedCount: 1, skippedCount: 2 });
    expect(d.respond).toHaveBeenCalledWith({ requestId: 'cp-7', verdict: 'apply', appliedCount: 1, skippedCount: 2 });
  });

  it('全跳过（Layer1 无变更 + discard 全 stale）：不落盘，仍回 apply（appliedCount=0）', async () => {
    const d = deps(nochange, { applied: 0, skipped: 2 });
    const p: CanvasOpProposal = { requestId: 'cp-6', ops: [{ kind: 'discardNode', nodeId: 'x' }, { kind: 'discardNode', nodeId: 'y' }] };
    await applyProposal(p, d);
    expect(d.save).not.toHaveBeenCalled();
    expect(d.respond).toHaveBeenCalledWith({ requestId: 'cp-6', verdict: 'apply', appliedCount: 0, skippedCount: 2 });
  });
});

describe('applyProposal 二刀：含付费生成（Layer2）', () => {
  function genDeps(
    result: ProposalApplyResult,
    genResults: Array<{ ok: boolean; costCny?: number }>,
    discard: { applied: number; skipped: number } = { applied: 0, skipped: 0 },
  ) {
    const order: string[] = [];
    let genCall = 0;
    return {
      order,
      applyBatch: vi.fn(() => { order.push('applyBatch'); return result; }),
      applyDiscards: vi.fn(() => { order.push('applyDiscards'); return discard; }),
      generate: vi.fn(async () => { order.push('generate'); return genResults[genCall++] ?? { ok: false }; }),
      clearHistory: vi.fn(() => { order.push('clearHistory'); }),
      save: vi.fn(() => { order.push('save'); }),
      respond: vi.fn(),
      genId: (k: string, i: number) => `${k}-${i}`,
      now: () => 1000,
    };
  }

  it('Layer1 严格先于 Layer2 生成，clearHistory 在生成之后（顺序写死）', async () => {
    const result: ProposalApplyResult = { next: { nodes: [], connectors: [], shapes: [] }, applied: [{ index: 0, kind: 'moveNode' }], skipped: [], changed: true };
    const d = genDeps(result, [{ ok: true, costCny: 0.14 }]);
    const p: CanvasOpProposal = {
      requestId: 'cp-g1',
      ops: [{ kind: 'generateImage', prompt: '一张登录页' }, { kind: 'moveNode', nodeId: 'a', x: 1, y: 2 }],
    };
    await applyProposal(p, d);
    // applyBatch 只收 Layer1（moveNode），不含 generateImage
    expect(d.applyBatch.mock.calls[0][0]).toHaveLength(1);
    expect(d.applyBatch.mock.calls[0][0][0]).toMatchObject({ kind: 'moveNode' });
    expect(d.generate).toHaveBeenCalledTimes(1);
    // 顺序：applyBatch → generate → clearHistory → save（Layer1 先于 Layer2，clearHistory 在生成后）
    expect(d.order.indexOf('applyBatch')).toBeLessThan(d.order.indexOf('generate'));
    expect(d.order.indexOf('generate')).toBeLessThan(d.order.indexOf('clearHistory'));
  });

  it('≥1 张生成成功才 clearHistory + 回灌真实合计花费', async () => {
    const d = genDeps(nochange, [{ ok: true, costCny: 0.14 }, { ok: true, costCny: 0.14 }]);
    const p: CanvasOpProposal = {
      requestId: 'cp-g2',
      ops: [{ kind: 'generateImage', prompt: 'a' }, { kind: 'generateImage', prompt: 'b' }],
    };
    const out = await applyProposal(p, d);
    expect(d.clearHistory).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ appliedCount: 2, skippedCount: 0 });
    expect(d.respond).toHaveBeenCalledWith({ requestId: 'cp-g2', verdict: 'apply', appliedCount: 2, skippedCount: 0, costCny: 0.28 });
  });

  it('全部生成失败：不 clearHistory（保 Layer1 可单次 undo）+ 计 skipped', async () => {
    const result: ProposalApplyResult = { next: { nodes: [], connectors: [], shapes: [] }, applied: [{ index: 0, kind: 'moveNode' }], skipped: [], changed: true };
    const d = genDeps(result, [{ ok: false }, { ok: false }]);
    const p: CanvasOpProposal = {
      requestId: 'cp-g3',
      ops: [{ kind: 'moveNode', nodeId: 'a', x: 1, y: 2 }, { kind: 'generateImage', prompt: 'a' }, { kind: 'generateImage', prompt: 'b' }],
    };
    const out = await applyProposal(p, d);
    expect(d.clearHistory).not.toHaveBeenCalled(); // 全失败保 Layer1 undo
    expect(d.save).toHaveBeenCalledTimes(1); // Layer1 有变更仍落盘
    expect(out).toMatchObject({ appliedCount: 1, skippedCount: 2 });
  });

  it('生成 op 但无 generate 依赖（非交互/降级）：计 skipped，不崩', async () => {
    const d = deps(nochange);
    const p: CanvasOpProposal = { requestId: 'cp-g4', ops: [{ kind: 'generateImage', prompt: 'a' }] };
    const out = await applyProposal(p, d);
    expect(out).toMatchObject({ appliedCount: 0, skippedCount: 1 });
  });

  // 审计 HIGH-2：单个 generate 抛错不能拖垮整批、不能吞掉 respond（否则 agent 挂到超时）。
  it('某张 generate 抛异常：计 skipped、继续后续、仍回 respond（不挂死 agent）', async () => {
    const d = genDeps(nochange, []);
    d.generate = vi.fn()
      .mockRejectedValueOnce(new Error('resolveDesignDir 失败'))
      .mockResolvedValueOnce({ ok: true, costCny: 0.14 });
    const p: CanvasOpProposal = { requestId: 'cp-g5', ops: [{ kind: 'generateImage', prompt: 'a' }, { kind: 'generateImage', prompt: 'b' }] };
    const out = await applyProposal(p, d);
    expect(d.generate).toHaveBeenCalledTimes(2); // 第一张抛错不阻断第二张
    expect(out).toMatchObject({ appliedCount: 1, skippedCount: 1 });
    expect(d.respond).toHaveBeenCalledWith({ requestId: 'cp-g5', verdict: 'apply', appliedCount: 1, skippedCount: 1, costCny: 0.14 });
  });

  // 审计 HIGH-1：每张付费产物落地后立即落盘（崩溃/关窗不丢已付费的图）。
  it('增量落盘：每张生成成功后即 save（不只末尾一次）', async () => {
    const d = genDeps(nochange, [{ ok: true, costCny: 0.14 }, { ok: true, costCny: 0.14 }]);
    const p: CanvasOpProposal = { requestId: 'cp-g6', ops: [{ kind: 'generateImage', prompt: 'a' }, { kind: 'generateImage', prompt: 'b' }] };
    await applyProposal(p, d);
    // 2 张各一次增量 save，顺序上每次 save 紧跟其 generate。
    const saves = d.order.filter((x) => x === 'save').length;
    expect(saves).toBeGreaterThanOrEqual(2);
    expect(d.order.indexOf('generate')).toBeLessThan(d.order.indexOf('save'));
  });

  // 审计 HIGH-1：落盘失败不中断付费批、不吞 respond（节点已在 store，下次 save 再持久化）。
  it('save 抛错：不中断、仍回 respond', async () => {
    const d = genDeps(nochange, [{ ok: true, costCny: 0.14 }]);
    d.save = vi.fn(() => { throw new Error('writeFile EACCES'); });
    const p: CanvasOpProposal = { requestId: 'cp-g7', ops: [{ kind: 'generateImage', prompt: 'a' }] };
    const out = await applyProposal(p, d);
    expect(out).toMatchObject({ appliedCount: 1 });
    expect(d.respond).toHaveBeenCalled();
  });

  // 审计 MED-1：付费生成期间锁画布（setBusy 包住 Phase B），禁用户手动编辑→避免收尾 clearHistory 误清。
  it('含生成批：setBusy(true) 在生成前、setBusy(false) 在生成后（即便抛错也复位）', async () => {
    const order: string[] = [];
    const d = {
      ...genDeps(nochange, [{ ok: true, costCny: 0.14 }]),
      setBusy: vi.fn((b: boolean) => order.push(b ? 'busy-on' : 'busy-off')),
    };
    const realGen = d.generate;
    d.generate = vi.fn(async (op) => { order.push('generate'); return realGen(op); });
    const p: CanvasOpProposal = { requestId: 'cp-g8', ops: [{ kind: 'generateImage', prompt: 'a' }] };
    await applyProposal(p, d);
    expect(order).toEqual(['busy-on', 'generate', 'busy-off']);
  });

  // 审计 R2 LOW-1：Phase A（applyBatch/applyDiscards）同步抛错也必须回 respond，否则 agent 挂死。
  it('applyBatch 同步抛错：兜底回 respond（reject），不挂死 agent', async () => {
    const d = genDeps(nochange, []);
    d.applyBatch = vi.fn(() => { throw new Error('malformed layer state'); });
    const p: CanvasOpProposal = { requestId: 'cp-g10', ops: [{ kind: 'moveNode', nodeId: 'a', x: 1, y: 2 }] };
    await applyProposal(p, d).catch(() => void 0); // 允许 rethrow，但 respond 必须先发出
    expect(d.respond).toHaveBeenCalledTimes(1);
    expect(d.respond.mock.calls[0][0]).toMatchObject({ requestId: 'cp-g10', verdict: 'reject' });
  });

  it('纯 Layer1 批（无生成）：不调 setBusy（无需锁画布）', async () => {
    const result: ProposalApplyResult = { next: { nodes: [], connectors: [], shapes: [] }, applied: [{ index: 0, kind: 'moveNode' }], skipped: [], changed: true };
    const d = { ...genDeps(result, []), setBusy: vi.fn() };
    const p: CanvasOpProposal = { requestId: 'cp-g9', ops: [{ kind: 'moveNode', nodeId: 'a', x: 1, y: 2 }] };
    await applyProposal(p, d);
    expect(d.setBusy).not.toHaveBeenCalled();
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
