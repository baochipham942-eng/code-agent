// ADR-026 D2-A：提议 Apply/Reject 落地逻辑（依赖注入，纯可测；UI 与 IPC 细节由 hook 注入）。
import type { CanvasOpProposal, CanvasProposalDecision } from '../../../shared/contract/canvasProposal';
import { normalizeProposal } from '../../../shared/contract/canvasProposal';
import type { ProposalApplyResult, ProposalApplyOpts } from './applyCanvasProposal';

export interface ProposalControllerDeps {
  /** store.applyProposalBatch（D3-B 整批单次快照）。 */
  applyBatch: (ops: CanvasOpProposal['ops'], opts: ProposalApplyOpts) => ProposalApplyResult;
  /** 落盘 canvas.json（仅在真有变更时调用）。 */
  save: () => Promise<void> | void;
  /** 经 IPC 回裁决给阻塞的 agent 工具。 */
  respond: (decision: CanvasProposalDecision) => Promise<void> | void;
  genId: (kind: string, index: number) => string;
  now: () => number;
}

/**
 * 批准并应用一批提议：D3-B 整批应用 → 有变更才落盘 → 回灌 appliedCount/skippedCount 给 agent。
 * 返回应用结果（供 UI 提示）。即使全跳过（stale-target）也回 apply（appliedCount=0）让 agent 知道。
 */
export async function applyProposal(
  proposal: CanvasOpProposal,
  deps: ProposalControllerDeps,
): Promise<ProposalApplyResult> {
  // 防御纵深：IPC 收到的 ops 在 renderer 侧再过一道校验/截断（不盲信 main 已校验的 payload）。
  const { ops } = normalizeProposal(proposal.ops);
  const result = deps.applyBatch(ops, { genId: deps.genId, now: deps.now() });
  if (result.changed) await deps.save();
  await deps.respond({
    requestId: proposal.requestId,
    verdict: 'apply',
    appliedCount: result.applied.length,
    skippedCount: result.skipped.length,
  });
  return result;
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
