// ============================================================================
// Pending Approval Persistence Types — ADR-010 #2
// ============================================================================
//
// 用一张 `pending_approvals` 表统一持久化两类 gate 的中途状态：
//   - kind = 'plan'   → PlanApprovalGate.pendingPlans
//   - kind = 'launch' → SwarmLaunchApprovalGate.requests
//
// 进程崩溃后，重启时 hydrate 把 pending 行重新载入 gate 的内存 Map，
// 但状态会被标成 'orphaned' —— 旧 promise resolver 已死，coordinator
// 必须显式 retry 或 cancel 才能放行后续流程。
// ============================================================================

export type PendingApprovalKind = 'plan' | 'launch';

/**
 * 持久化状态机：
 *   pending  - 等待 coordinator 决定
 *   approved - 已通过
 *   rejected - 已拒绝（含超时 fail-closed）
 *   orphaned - 上一次进程在 pending 时退出，重启 hydrate 后标记
 */
export type PendingApprovalStatus = 'pending' | 'approved' | 'rejected' | 'orphaned';

export interface PendingApprovalRecord {
  id: string;
  kind: PendingApprovalKind;
  agentId: string | null;
  agentName: string | null;
  coordinatorId: string | null;
  payloadJson: string;
  status: PendingApprovalStatus;
  submittedAt: number;
  resolvedAt: number | null;
  feedback: string | null;
}
