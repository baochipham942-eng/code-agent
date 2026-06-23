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
  /**
   * 二刀（审计 MED-1）：付费生成期间锁画布忙态（renderer 注入 store.setGenerating + 阻断叠层）。
   * 串行出图可达数分钟，不锁则用户中途手动编辑会被收尾 clearHistory 连带清掉 undo。仅含生成批调用。
   */
  setBusy?: (busy: boolean) => void;
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
  // 顶层兜底（审计 R2 LOW-1）：Phase A 的 applyBatch/applyDiscards 是同步调用，万一抛错
  // （如畸形 layer 态）会绕过 respond，让阻塞的 agent 挂到超时。这里保证任何未捕获抛错都先回一个
  // reject 再外抛——agent 立即解阻、知道没应用；UI 侧由 apply() 的 finally 清掉审批条。
  let responded = false;
  try {
  // 防御纵深：IPC 收到的 ops（或用户勾选的子集）在 renderer 侧再过一道校验/截断。
  const { ops } = normalizeProposal(selectedOps ?? proposal.ops);
  const layer1Ops = ops.filter((o) => o.kind !== 'discardNode' && !isGenerateOp(o));
  const discardIds = ops.filter((o): o is { kind: 'discardNode'; nodeId: string } => o.kind === 'discardNode').map((o) => o.nodeId);
  const genOps = ops.filter(isGenerateOp);

  // Phase A：Layer1 整批单次快照（同步纯）。
  const layer1 = deps.applyBatch(layer1Ops, { genId: deps.genId, now: deps.now() });
  // discard（软删，不进 Cmd+Z）。
  const discard = deps.applyDiscards(discardIds);

  // 落盘失败不中断付费批、不吞 respond：节点已在 store，下次 save 再持久化（审计 HIGH-1）。
  const safeSave = async (): Promise<void> => {
    try { await deps.save(); } catch { /* 落盘失败容忍：内存态已对，避免因 I/O 错中断付费批/挂死 agent */ }
  };

  // Phase B：Layer2 串行生成（含付费）。逐个 await，累计成功数 + 实际花费。
  let genApplied = 0;
  let genSkipped = 0;
  let genCostCny = 0;
  if (genOps.length > 0) deps.setBusy?.(true); // MED-1：付费期间锁画布，禁手动编辑
  try {
    for (const op of genOps) {
      if (!deps.generate) { genSkipped++; continue; } // 非交互/降级：无出图能力，计 skipped 不崩
      let r: { ok: boolean; costCny?: number };
      // HIGH-2：单张抛错（如 resolveDesignDir 失败）只计本张 skipped，不拖垮整批、不吞 respond。
      try { r = await deps.generate(op); } catch { r = { ok: false }; }
      if (r.ok) {
        genApplied++;
        if (typeof r.costCny === 'number' && r.costCny >= 0) genCostCny += r.costCny;
        await safeSave(); // HIGH-1：每张付费产物立即落盘，崩溃/关窗不丢已付费的图
      } else {
        genSkipped++;
      }
    }
  } finally {
    if (genOps.length > 0) deps.setBusy?.(false); // 即便中途异常也解锁画布
  }
  // 收尾：当且仅当 ≥1 张生成真落地才清 Layer1 编辑栈（#274 边界不变量）；全失败保 Layer1 undo。
  if (genApplied > 0) deps.clearHistory?.();

  const changed = layer1.changed || discard.applied > 0 || genApplied > 0;
  if (changed) await safeSave();

  // 用户在 per-op 取舍里取消勾选的 op 也计入 skipped——否则 agent 不知这些被用户主动否决，
  // 可能反复重提（L1）。deselected = 原批 - 用户选中的子集。
  const deselected = selectedOps ? Math.max(0, proposal.ops.length - selectedOps.length) : 0;
  const appliedCount = layer1.applied.length + discard.applied + genApplied;
  const skippedCount = layer1.skipped.length + discard.skipped + deselected + genSkipped;
  responded = true; // R3 LOW-1：标记已应答，正常 respond 即将发出（即便它抛错也不在 catch 补发 reject）
  await deps.respond({
    requestId: proposal.requestId,
    verdict: 'apply',
    appliedCount,
    skippedCount,
    ...(genCostCny > 0 ? { costCny: genCostCny } : {}),
  });
  return { appliedCount, skippedCount, layer1 };
  } catch (err) {
    // 兜底：Phase A 同步抛错等未应答情形才补发 reject 让 agent 解阻（R3 LOW-1：已应答则不补，
    // 否则画布改动已落地却补 reject 会与 agent 认知 desync）。best-effort，respond 再失败也吞掉。
    if (!responded) {
      try { await deps.respond({ requestId: proposal.requestId, verdict: 'reject', feedback: '画布应用内部错误' }); } catch { /* ignore */ }
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
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
