// ADR-027 slice3：提议放行判断 + 预算闸（renderer 纯逻辑）。付费安全核心，逐条锁死。
import { describe, it, expect, vi } from 'vitest';
import {
  decideProposalHandling,
  hasDestructiveOp,
  makeBudgetedGenerate,
  makeGroupedGenerate,
  planUnpickedDiscards,
  autonomousApply,
} from '@renderer/components/design/autonomyProposalRouting';
import type { CanvasNode } from '@renderer/components/design/designCanvasTypes';
import type { ProposalControllerDeps } from '@renderer/components/design/canvasProposalController';
import type { ProposalApplyResult } from '@renderer/components/design/applyCanvasProposal';
import { grantEnvelope, consume, type AutonomyEnvelope } from '@shared/contract/designAutonomy';
import type { CanvasOpProposal, CanvasProposalDecision, ProposeGenerateImageOp } from '@shared/contract';

function proposal(ops: CanvasOpProposal['ops']): CanvasOpProposal {
  return { requestId: 'r1', ops };
}
const gen = (prompt = 'x'): ProposeGenerateImageOp => ({ kind: 'generateImage', prompt });
const move = { kind: 'moveNode', nodeId: 'n', x: 0, y: 0 } as const;
const discard = { kind: 'discardNode', nodeId: 'n' } as const;

describe('decideProposalHandling · 自动 vs 人闸', () => {
  it('无信封 → gate（走 026 逐步人审批）', () => {
    expect(decideProposalHandling(proposal([gen()]), null)).toBe('gate');
  });

  it('有信封 + 纯文生图 → auto', () => {
    const env = grantEnvelope({ maxVariants: 3 });
    expect(decideProposalHandling(proposal([gen('a'), gen('b')]), env)).toBe('auto');
  });

  it('有信封 + 含破坏性 discardNode → gate（破坏性 break out 回逐步，红线/边界3）', () => {
    const env = grantEnvelope({ maxVariants: 3 });
    expect(decideProposalHandling(proposal([gen(), discard]), env)).toBe('gate');
  });

  it('有信封 + 纯免费 Layer1（move）→ auto（免费非破坏自动应用，不吃预算）', () => {
    const env = grantEnvelope({ maxVariants: 3 });
    expect(decideProposalHandling(proposal([move]), env)).toBe('auto');
  });

  it('有信封 + 文生图混免费 Layer1（无破坏性）→ auto', () => {
    const env = grantEnvelope({ maxVariants: 3 });
    expect(decideProposalHandling(proposal([gen(), move]), env)).toBe('auto');
  });

  it('hasDestructiveOp：仅 discardNode 触发', () => {
    expect(hasDestructiveOp([gen(), move])).toBe(false);
    expect(hasDestructiveOp([discard])).toBe(true);
  });
});

describe('makeBudgetedGenerate · 预算闸 + 消费', () => {
  function setup(env = grantEnvelope({ maxVariants: 3, maxCny: 1 })) {
    let current = env as ReturnType<typeof grantEnvelope> | null;
    const raw = vi.fn(async () => ({ ok: true, costCny: 0.14 }));
    const estimateCost = vi.fn(() => 0.14);
    const setEnvelope = vi.fn((e: ReturnType<typeof grantEnvelope>) => { current = e; });
    const gate = makeBudgetedGenerate({
      estimateCost,
      rawGenerate: raw,
      getEnvelope: () => current,
      setEnvelope,
    });
    return { gate, raw, estimateCost, setEnvelope, getEnv: () => current };
  }

  it('预算够 → 调 rawGenerate，成功消费(变体+1, ¥+actual)', async () => {
    const { gate, raw, getEnv } = setup();
    const r = await gate(gen());
    expect(r.ok).toBe(true);
    expect(raw).toHaveBeenCalledOnce();
    expect(getEnv()!.usedVariants).toBe(1);
    expect(getEnv()!.spentCny).toBeCloseTo(0.14, 6);
  });

  it('变体槽耗尽 → 不调 rawGenerate（零付费），返回 ok:false', async () => {
    const { gate, raw } = setup(consume(grantEnvelope({ maxVariants: 1, maxCny: 10 }), { landed: true, costCny: 0.14 }));
    const r = await gate(gen());
    expect(r.ok).toBe(false);
    expect(raw).not.toHaveBeenCalled(); // 预算闸在付费前拦
  });

  it('单张 est 超出剩余 ¥ → 不调 rawGenerate（零付费）', async () => {
    const { gate, raw, estimateCost } = setup(grantEnvelope({ maxVariants: 5, maxCny: 0.1 }));
    estimateCost.mockReturnValue(0.14);
    const r = await gate(gen());
    expect(r.ok).toBe(false);
    expect(raw).not.toHaveBeenCalled();
  });

  it('生成失败 → 消费 landed:false（不吃变体槽），返回 ok:false', async () => {
    const { gate, raw, getEnv } = setup();
    raw.mockResolvedValueOnce({ ok: false });
    const r = await gate(gen());
    expect(r.ok).toBe(false);
    expect(raw).toHaveBeenCalledOnce();
    expect(getEnv()!.usedVariants).toBe(0); // 失败不吃版本槽
  });

  it('无信封 → 不调 rawGenerate（auto 路径不该到这，防御）', async () => {
    const raw = vi.fn(async () => ({ ok: true, costCny: 0.14 }));
    const gate = makeBudgetedGenerate({ estimateCost: () => 0.14, rawGenerate: raw, getEnvelope: () => null, setEnvelope: vi.fn() });
    const r = await gate(gen());
    expect(r.ok).toBe(false);
    expect(raw).not.toHaveBeenCalled();
  });

  it('连续三张跑满信封：第 4 张被预算闸硬停（端到端账本）', async () => {
    const { gate, raw } = setup(grantEnvelope({ maxVariants: 3, maxCny: 1 }));
    expect((await gate(gen())).ok).toBe(true);
    expect((await gate(gen())).ok).toBe(true);
    expect((await gate(gen())).ok).toBe(true);
    expect((await gate(gen())).ok).toBe(false); // 信封耗尽
    expect(raw).toHaveBeenCalledTimes(3); // 只付费 3 次
  });
});

describe('autonomousApply · 自动应用编排（注入预算闸 + 回填剩余预算）', () => {
  const emptyLayer1: ProposalApplyResult = { next: {} as never, applied: [], skipped: [], changed: false };

  function setup(env: AutonomyEnvelope) {
    let current: AutonomyEnvelope | null = env;
    const respondRaw = vi.fn<(d: CanvasProposalDecision) => void>();
    const rawGenerate = vi.fn(async () => ({ ok: true, costCny: 0.14 }));
    const baseDeps: ProposalControllerDeps = {
      applyBatch: () => emptyLayer1,
      applyDiscards: () => ({ applied: 0, skipped: 0 }),
      save: vi.fn(),
      respond: respondRaw,
      genId: (k, i) => `${k}-${i}`,
      now: () => 1,
      generate: rawGenerate,
      clearHistory: vi.fn(),
      setBusy: vi.fn(),
    };
    return {
      respondRaw,
      rawGenerate,
      run: (proposal: CanvasOpProposal) =>
        autonomousApply(proposal, {
          baseDeps,
          estimateCost: () => 0.14,
          getEnvelope: () => current,
          setEnvelope: (e) => { current = e; },
        }),
    };
  }

  it('单张文生图自动出图 → respond 带 autonomy{剩余/未耗尽}', async () => {
    const { run, respondRaw, rawGenerate } = setup(grantEnvelope({ maxVariants: 3, maxCny: 1 }));
    await run({ requestId: 'r1', ops: [gen('a')] });
    expect(rawGenerate).toHaveBeenCalledOnce();
    expect(respondRaw).toHaveBeenCalledOnce();
    const decision = respondRaw.mock.calls[0][0];
    expect(decision.verdict).toBe('apply');
    expect(decision.autonomy).toEqual({ remainingVariants: 2, remainingCny: expect.closeTo(0.86, 6), exhausted: false });
  });

  it('信封已满 → 该张被预算闸跳过(零付费)，respond 标 exhausted', async () => {
    const full = consume(grantEnvelope({ maxVariants: 1, maxCny: 10 }), { landed: true, costCny: 0.14 });
    const { run, respondRaw, rawGenerate } = setup(full);
    await run({ requestId: 'r1', ops: [gen('a')] });
    expect(rawGenerate).not.toHaveBeenCalled(); // 预算闸拦在付费前
    const decision = respondRaw.mock.calls[0][0];
    expect(decision.autonomy!.exhausted).toBe(true);
    expect(decision.autonomy!.remainingVariants).toBe(0);
  });
});

describe('makeGroupedGenerate · 变体分组（D3/D5）', () => {
  it('首张无 parentId、成功后用其 nodeId 建组', async () => {
    let group: string | null = null;
    const generate = vi.fn(async () => ({ ok: true, costCny: 0.14, nodeId: 'node-1' }));
    const grouped = makeGroupedGenerate({ getGroupId: () => group, setGroupId: (id) => { group = id; }, generate });
    await grouped(gen());
    expect(generate).toHaveBeenCalledWith(expect.anything(), undefined); // 首张无 parentId
    expect(group).toBe('node-1'); // 建组
  });

  it('后续张归入已建的组（parentId=组 id），不重建组', async () => {
    let group: string | null = 'node-1';
    const generate = vi.fn(async () => ({ ok: true, costCny: 0.14, nodeId: 'node-2' }));
    const grouped = makeGroupedGenerate({ getGroupId: () => group, setGroupId: (id) => { group = id; }, generate });
    await grouped(gen());
    expect(generate).toHaveBeenCalledWith(expect.anything(), { parentId: 'node-1' });
    expect(group).toBe('node-1'); // 不变
  });

  it('首张失败不建组（下张仍是组首张）', async () => {
    let group: string | null = null;
    const generate = vi.fn(async () => ({ ok: false }));
    const grouped = makeGroupedGenerate({ getGroupId: () => group, setGroupId: (id) => { group = id; }, generate });
    await grouped(gen());
    expect(group).toBeNull();
  });
});

describe('planUnpickedDiscards · 人挑后软删同组其余（D5）', () => {
  const mk = (id: string, parentId?: string, discarded?: boolean): CanvasNode =>
    ({ id, x: 0, y: 0, width: 1, height: 1, src: 'x', createdAt: 1, ...(parentId ? { parentId } : {}), ...(discarded ? { discarded } : {}) }) as CanvasNode;

  it('挑组首张 → 同组其余存活变体被列入软删', () => {
    const nodes = [mk('a'), mk('b', 'a'), mk('c', 'a')];
    expect(planUnpickedDiscards(nodes, 'a').sort()).toEqual(['b', 'c']);
  });

  it('挑子变体 → 组首张 + 其余子变体都软删（同 groupKey=a）', () => {
    const nodes = [mk('a'), mk('b', 'a'), mk('c', 'a')];
    expect(planUnpickedDiscards(nodes, 'b').sort()).toEqual(['a', 'c']);
  });

  it('已淘汰的不重复软删；别组节点不动', () => {
    const nodes = [mk('a'), mk('b', 'a', true), mk('x'), mk('y', 'x')];
    expect(planUnpickedDiscards(nodes, 'a')).toEqual([]); // b 已淘汰；x/y 是别组
  });

  it('挑不存在的 id → 空', () => {
    expect(planUnpickedDiscards([mk('a')], 'zzz')).toEqual([]);
  });
});
