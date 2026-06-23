// ============================================================================
// 有界自主 · 提议放行判断 + 预算闸（ADR-027 slice3，renderer 纯逻辑）
// ----------------------------------------------------------------------------
// 当 agent 提议经 CANVAS_PROPOSAL_ASK 到达时：有活跃信封 ∧ 非破坏性 → 自动应用（不弹人闸）；
// 否则走 026 逐步人审批。付费 op 在自动路径内逐张过预算闸（付费前 est 拦，红线①），
// 失败不吃版本槽，账本经 setEnvelope 持久消费。
// ============================================================================
import type { CanvasProposalOp, CanvasOpProposal, CanvasProposalDecision, ProposeGenerateImageOp } from '@shared/contract';
import { type AutonomyEnvelope, canAfford, consume, remaining, isExhausted } from '@shared/contract/designAutonomy';
import { applyProposal, type ProposalControllerDeps, type ProposalApplyOutcome } from './canvasProposalController';

/** 是否含破坏性 op（discardNode）——破坏性永远逐步审批，不进自主（边界3）。 */
export function hasDestructiveOp(ops: CanvasProposalOp[]): boolean {
  return ops.some((o) => o.kind === 'discardNode');
}

/**
 * 决定一个提议怎么处理：
 * - `gate`：走 026 逐步人审批（无信封 / 含破坏性 op）。
 * - `auto`：在信封内自动应用（免费 Layer1 直接落、付费 op 逐张过预算闸）。
 */
export function decideProposalHandling(
  proposal: CanvasOpProposal,
  envelope: AutonomyEnvelope | null,
): 'auto' | 'gate' {
  if (!envelope) return 'gate';
  if (hasDestructiveOp(proposal.ops)) return 'gate';
  return 'auto';
}

export interface BudgetedGenerateDeps {
  /** 该生成 op 的预估 ¥（renderer 查价表，付费前闸用）。 */
  estimateCost: (op: ProposeGenerateImageOp) => number;
  /** 真出图原语（不含预算逻辑）。 */
  rawGenerate: (op: ProposeGenerateImageOp) => Promise<{ ok: boolean; costCny?: number }>;
  /** 取当前活跃信封（每张前重取，反映前序消费）。 */
  getEnvelope: () => AutonomyEnvelope | null;
  /** 消费后持久化新信封。 */
  setEnvelope: (env: AutonomyEnvelope) => void;
}

/**
 * 包一层「预算闸 + 消费」的出图函数，注入 applyProposal 的 deps.generate（自动路径专用）。
 * 逐张：付费前查 canAfford（不够则跳过、零付费）→ 真出图 → 按成败 consume（失败不吃版本槽）→ 持久化。
 * 必须串行调用（applyProposal Phase B 即串行），否则并发消费会算错预算。
 */
export function makeBudgetedGenerate(
  deps: BudgetedGenerateDeps,
): (op: ProposeGenerateImageOp) => Promise<{ ok: boolean; costCny?: number }> {
  return async (op) => {
    const env = deps.getEnvelope();
    if (!env) return { ok: false }; // 防御：自动路径不该在无信封时到这
    const est = deps.estimateCost(op);
    if (!canAfford(env, est)) return { ok: false }; // 预算闸：付费前拦，零付费
    const r = await deps.rawGenerate(op);
    deps.setEnvelope(consume(env, { landed: r.ok, costCny: r.costCny ?? 0 }));
    return r;
  };
}

export interface AutonomousApplyDeps {
  /** 026 现有控制器依赖（applyBatch/applyDiscards/save/genId/now/clearHistory/setBusy + generate=原始出图）。 */
  baseDeps: ProposalControllerDeps;
  /** 该生成 op 的预估 ¥（付费前闸用）。 */
  estimateCost: (op: ProposeGenerateImageOp) => number;
  getEnvelope: () => AutonomyEnvelope | null;
  setEnvelope: (env: AutonomyEnvelope) => void;
}

/**
 * 自主自动应用：在 026 双相落地之上注入「预算闸 generate」+「回填剩余预算的 respond」。
 * - generate 换成 makeBudgetedGenerate（付费前 est 闸、按成败消费信封）。
 * - respond 包一层：消费后读最新信封，附 autonomy{剩余变体/¥/是否耗尽} 回灌 agent。
 * 复用 applyProposal 的双相顺序/历史/落盘不变量，绝不另写一套 mutate/付费路径。
 */
export async function autonomousApply(
  proposal: CanvasOpProposal,
  deps: AutonomousApplyDeps,
): Promise<ProposalApplyOutcome> {
  const rawGenerate = deps.baseDeps.generate;
  const budgetedGenerate = rawGenerate
    ? makeBudgetedGenerate({ estimateCost: deps.estimateCost, rawGenerate, getEnvelope: deps.getEnvelope, setEnvelope: deps.setEnvelope })
    : undefined;
  const respond = (decision: CanvasProposalDecision): Promise<void> | void => {
    const env = deps.getEnvelope();
    const rem = env ? remaining(env) : { variants: 0, cny: 0 };
    return deps.baseDeps.respond({
      ...decision,
      autonomy: { remainingVariants: rem.variants, remainingCny: rem.cny, exhausted: env ? isExhausted(env) : true },
    });
  };
  return applyProposal(proposal, { ...deps.baseDeps, generate: budgetedGenerate, respond });
}
