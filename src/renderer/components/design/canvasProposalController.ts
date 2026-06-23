// ADR-026 D2-A：提议 Apply/Reject 落地逻辑（依赖注入，纯可测；UI 与 IPC 细节由 hook 注入）。
import type { CanvasOpProposal, CanvasProposalDecision } from '../../../shared/contract/canvasProposal';
import { normalizeProposal } from '../../../shared/contract/canvasProposal';
import type { ProposalApplyResult, ProposalApplyOpts } from './applyCanvasProposal';

export interface ProposalControllerDeps {
  /** store.applyProposalBatch（D3-B 整批单次快照，仅 Layer1 op）。 */
  applyBatch: (ops: CanvasOpProposal['ops'], opts: ProposalApplyOpts) => ProposalApplyResult;
  /** 软删（淘汰）一批节点（走 store.discardNode，Layer2 非破坏可恢复）；返回实际淘汰/跳过数。 */
  applyDiscards: (nodeIds: string[]) => { applied: number; skipped: number };
  /** 落盘 canvas.json（仅在真有变更时调用）。 */
  save: () => Promise<void> | void;
  /** 经 IPC 回裁决给阻塞的 agent 工具。 */
  respond: (decision: CanvasProposalDecision) => Promise<void> | void;
  genId: (kind: string, index: number) => string;
  now: () => number;
}

/** Apply 落地结果汇总（Layer1 + discard 合并计数，供 UI 提示 + 回灌 agent）。 */
export interface ProposalApplyOutcome {
  appliedCount: number;
  skippedCount: number;
  /** Layer1 批处理明细（discard 不在内）。 */
  layer1: ProposalApplyResult;
}

/**
 * 批准并应用提议（三刀）：
 * - 可只应用 selectedOps（per-op 取舍；省略=整批）。
 * - Layer1 op（移动/连线/形状/标注）→ applyBatch（D3-B 整批单次快照，一次 undo 撤完）。
 * - discardNode（软删）→ applyDiscards（Layer2，不进 Cmd+Z，靠恢复入口找回）。
 * 有变更才落盘；回灌合并后的 appliedCount/skippedCount 给 agent（即使全跳过也回 apply）。
 */
export async function applyProposal(
  proposal: CanvasOpProposal,
  deps: ProposalControllerDeps,
  selectedOps?: CanvasOpProposal['ops'],
): Promise<ProposalApplyOutcome> {
  // 防御纵深：IPC 收到的 ops（或用户勾选的子集）在 renderer 侧再过一道校验/截断。
  const { ops } = normalizeProposal(selectedOps ?? proposal.ops);
  const layer1Ops = ops.filter((o) => o.kind !== 'discardNode');
  const discardIds = ops.filter((o): o is { kind: 'discardNode'; nodeId: string } => o.kind === 'discardNode').map((o) => o.nodeId);

  const layer1 = deps.applyBatch(layer1Ops, { genId: deps.genId, now: deps.now() });
  const discard = deps.applyDiscards(discardIds);

  const changed = layer1.changed || discard.applied > 0;
  if (changed) await deps.save();

  // 用户在 per-op 取舍里取消勾选的 op 也计入 skipped——否则 agent 不知这些被用户主动否决，
  // 可能反复重提（L1）。deselected = 原批 - 用户选中的子集。
  const deselected = selectedOps ? Math.max(0, proposal.ops.length - selectedOps.length) : 0;
  const appliedCount = layer1.applied.length + discard.applied;
  const skippedCount = layer1.skipped.length + discard.skipped + deselected;
  await deps.respond({ requestId: proposal.requestId, verdict: 'apply', appliedCount, skippedCount });
  return { appliedCount, skippedCount, layer1 };
}

/** 拒绝提议：不改画布，回 reject（带可选修改意见）给 agent。 */
export async function rejectProposal(
  proposal: CanvasOpProposal,
  deps: Pick<ProposalControllerDeps, 'respond'>,
  feedback?: string,
): Promise<void> {
  await deps.respond({
    requestId: proposal.requestId,
    verdict: 'reject',
    ...(feedback && feedback.trim() ? { feedback: feedback.trim() } : {}),
  });
}
