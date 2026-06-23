// ADR-026 D2-A：提议 Apply/Reject 落地逻辑（依赖注入，纯可测；UI 与 IPC 细节由 hook 注入）。
import type { CanvasOpProposal, CanvasProposalDecision, ProposeGenerateImageOp } from '../../../shared/contract/canvasProposal';
import { normalizeProposal, isGenerateOp } from '../../../shared/contract/canvasProposal';
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
  /**
   * 二刀 Layer2：生成一张提议图（含付费），renderer 注入真实出图（出图 IPC + addNode，**不落盘不清史**，
   * 由本控制器统一收尾）。返回是否成功 + 实际花费（¥）。缺省（非交互/降级）则生成 op 全计 skipped。
   */
  generate?: (op: ProposeGenerateImageOp) => Promise<{ ok: boolean; costCny?: number }>;
  /** 二刀：≥1 张生成真落地后清 Layer1 编辑栈（#274 跨生成边界不变量）；全失败不清，保 Layer1 单次 undo。 */
  clearHistory?: () => void;
}

/** Apply 落地结果汇总（Layer1 + discard 合并计数，供 UI 提示 + 回灌 agent）。 */
export interface ProposalApplyOutcome {
  appliedCount: number;
  skippedCount: number;
  /** Layer1 批处理明细（discard 不在内）。 */
  layer1: ProposalApplyResult;
}

/**
 * 批准并应用提议（三刀 + 二刀混批顺序写死，见 ADR-026 增补-D1/D2）：
 * - 可只应用 selectedOps（per-op 取舍；省略=整批）。
 * - **顺序硬编码**：Phase A Layer1（移动/连线/形状/标注，applyBatch 整批单次快照）→ discard 软删
 *   → Phase B Layer2 串行生成（含付费，deps.generate 逐个 await）→ 收尾 clearHistory（仅 ≥1 张真落地）。
 * - Layer1 严格先于 Layer2：Layer2 addNode 跨快照数组边界，clearHistory 会销毁 Layer1 undo frame；
 *   若 Layer2 先跑，Layer1 快照会在节点集已变后才拍 → reconcile 错配（重蹈 #274 跨生成 undo 删节点）。
 * - 全部生成失败则**不** clearHistory（保 Layer1 单次 undo）。
 * 有变更才落盘；回灌合并后的 appliedCount/skippedCount（+ 实际合计花费 costCny）给 agent（即使全跳过也回 apply）。
 */
export async function applyProposal(
  proposal: CanvasOpProposal,
  deps: ProposalControllerDeps,
  selectedOps?: CanvasOpProposal['ops'],
): Promise<ProposalApplyOutcome> {
  // 防御纵深：IPC 收到的 ops（或用户勾选的子集）在 renderer 侧再过一道校验/截断。
  const { ops } = normalizeProposal(selectedOps ?? proposal.ops);
  const layer1Ops = ops.filter((o) => o.kind !== 'discardNode' && !isGenerateOp(o));
  const discardIds = ops.filter((o): o is { kind: 'discardNode'; nodeId: string } => o.kind === 'discardNode').map((o) => o.nodeId);
  const genOps = ops.filter(isGenerateOp);

  // Phase A：Layer1 整批单次快照（同步纯）。
  const layer1 = deps.applyBatch(layer1Ops, { genId: deps.genId, now: deps.now() });
  // discard（软删，不进 Cmd+Z）。
  const discard = deps.applyDiscards(discardIds);

  // Phase B：Layer2 串行生成（含付费）。逐个 await，累计成功数 + 实际花费。
  let genApplied = 0;
  let genSkipped = 0;
  let genCostCny = 0;
  for (const op of genOps) {
    if (!deps.generate) { genSkipped++; continue; } // 非交互/降级：无出图能力，计 skipped 不崩
    const r = await deps.generate(op);
    if (r.ok) {
      genApplied++;
      if (typeof r.costCny === 'number' && r.costCny >= 0) genCostCny += r.costCny;
    } else {
      genSkipped++;
    }
  }
  // 收尾：当且仅当 ≥1 张生成真落地才清 Layer1 编辑栈（#274 边界不变量）；全失败保 Layer1 undo。
  if (genApplied > 0) deps.clearHistory?.();

  const changed = layer1.changed || discard.applied > 0 || genApplied > 0;
  if (changed) await deps.save();

  // 用户在 per-op 取舍里取消勾选的 op 也计入 skipped——否则 agent 不知这些被用户主动否决，
  // 可能反复重提（L1）。deselected = 原批 - 用户选中的子集。
  const deselected = selectedOps ? Math.max(0, proposal.ops.length - selectedOps.length) : 0;
  const appliedCount = layer1.applied.length + discard.applied + genApplied;
  const skippedCount = layer1.skipped.length + discard.skipped + deselected + genSkipped;
  await deps.respond({
    requestId: proposal.requestId,
    verdict: 'apply',
    appliedCount,
    skippedCount,
    ...(genCostCny > 0 ? { costCny: genCostCny } : {}),
  });
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
