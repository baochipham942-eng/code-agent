// ============================================================================
// Pending Approval Persistence Types — ADR-010 #2
// ============================================================================
//
// 用一张 `pending_approvals` 表统一持久化三类 gate 的中途状态：
//   - kind = 'plan'          → PlanApprovalGate.pendingPlans
//   - kind = 'launch'        → SwarmLaunchApprovalGate.requests
//   - kind = 'tool_approval' → AgentOrchestrator 无人值守停车挂起（B2）
//
// 进程崩溃后，重启时 hydrate 把 pending 行重新载入 gate 的内存 Map，
// 但状态会被标成 'orphaned' —— 旧 promise resolver 已死，coordinator
// 必须显式 retry 或 cancel 才能放行后续流程。
// ============================================================================

export type PendingApprovalKind = 'plan' | 'launch' | 'tool_approval';

/**
 * kind='tool_approval' 停车行的 payload（B2）。无人值守会话的工具审批请求超时不再 deny，
 * 改为写入 pending_approvals 挂起，等收件箱/会话卡任一入口应答。
 * displayTool/displayAction 是给收件箱 UI 的人话字段；riskClass 承接 B1 分类供 scopeNote 消费。
 */
export interface ToolApprovalPayload {
  sessionId: string | null;
  /** 工具内部名（如 mcp__lark__...） */
  tool: string;
  /** 权限类型（file_write / command / mcp ...） */
  type: string;
  /** 权限级别（low/medium/high，getPermissionLevel 结果） */
  permissionLevel: string;
  /** 请求发起时间戳（epoch ms） */
  requestedAt: number;
  /** 参数摘要（命令/路径/URL 等，供收件箱一眼可辨；已裁剪，非完整入参） */
  argsSummary?: string;
  /** 人话工具名，给非程序员协作者看 */
  displayTool?: string;
  /** 人话动作描述 */
  displayAction?: string;
  /** B1 对外风险类（EXTERNAL 等），null 表示未分类 */
  riskClass?: string | null;
  /**
   * B4 授权目标精确串（收件人/频道 id 等）。仅当工具是 external 且能确定性提取 target 时非空；
   * 有它 = 该行可铸造 target 粒度长期授权（收件箱审批卡出「每次都允许发 <target>」按钮）。
   */
  standingGrantTarget?: string | null;
}

/** 收件箱「等待批准的操作」分组的行数据（B2）。id=requestId，回传 permissionResponse 用。 */
export interface ParkedApprovalInboxItem {
  id: string;
  sessionId: string | null;
  tool: string;
  displayTool?: string;
  /** epoch ms，UI 算等待时长 */
  requestedAt: number;
  /** pending=可批准/拒绝；orphaned=应用重启后过期，灰态不可操作 */
  status: 'pending' | 'orphaned';
  riskClass?: string | null;
  /** B4 授权目标精确串；非空 = 可铸造 target 粒度长期授权（出「每次都允许发 <target>」按钮） */
  standingGrantTarget?: string | null;
}

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
