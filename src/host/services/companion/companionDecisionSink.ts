import type { PermissionResponse } from '../../../shared/contract/permission';
import type { CompanionApprovalAnswer, CompanionDecisionOutcome } from '../../../shared/contract/companion';

export type CompanionApprovalHostSettlement = {
  requestId: string;
  outcome: CompanionDecisionOutcome;
  answer?: CompanionApprovalAnswer;
};

type Listener = (event: CompanionApprovalHostSettlement) => void;
let listener: Listener | null = null;

/**
 * requestId 当前是否处在 companion respond 的 deliver 同步窗口内。
 * 宿主结算监听（settleFromHost）靠它抑制回声；审批岛靠它分辨「这条应答来自手机」，
 * 只有手机先答的裁决才向桌面回传带 resolvedBy 的 resolved 事件——桌面自己点的
 * 那条路一个字节都不能变。放在本模块而不是 CompanionApprovalService 的私有字段，
 * 是因为两处都要问同一个事实，必须单一真源。
 */
const companionResponding = new Set<string>();

export function markCompanionApprovalResponding(requestId: string): void {
  companionResponding.add(requestId);
}

export function unmarkCompanionApprovalResponding(requestId: string): void {
  companionResponding.delete(requestId);
}

export function isCompanionApprovalResponding(requestId: string): boolean {
  return companionResponding.has(requestId);
}

export function bindCompanionApprovalListener(next: Listener | null): void {
  listener = next;
}

export function noteCompanionApprovalSettlement(event: CompanionApprovalHostSettlement): void {
  try { listener?.(event); } catch { /* A card projection must not fail the permission island. */ }
}

export function approvalAnswerFromPermission(response: PermissionResponse): CompanionApprovalAnswer {
  if (response === 'allow_session') return { decision: 'allow_session' };
  if (response === 'allow' || response === 'allow_standing') return { decision: 'approved' };
  return { decision: 'rejected' };
}
