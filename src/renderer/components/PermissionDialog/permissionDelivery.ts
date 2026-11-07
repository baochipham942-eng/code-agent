/**
 * 审批应答有没有真的送达宿主。AGENT_PERMISSION_RESPONSE 的注册类型写的是 Promise<void>
 * （src/shared/ipc/handlers.ts），与实现不符，所以按 unknown 收窄。真实写点只有三种形状：
 *   Electron 式 legacy handler → {outcome}（'delivered' / 'unknown_request' / 'no_orchestrator'
 *     / 'no_session' / 'storage_unavailable'，agent.ipc.ts handlePermissionResponse）；
 *   web HTTP 桥 → 送达时解包成 {requestId, sessionId, source}（没有 outcome 字段）；
 *     停车审批宿主已随重启消失、由幸存行接手时 → {outcome:非 delivered, resumed}，
 *     resumed 为 'executed' / 'denied' / 'already_present' 表示台账执行器已落定这一步，算送达；
 *     'closed'（重启后超 24 小时、参数取不回、运行已结束：审批被收口拒绝、命令没跑）
 *     与 'lost_race' 算失效；
 *     宿主消失且收口拒绝时 → {outcome, closed:true}，算失效；
 *     未送达时原样透传 {success:false, error:{code}}（webPermissionResponseHandler.ts）；
 *   host 同步入口会直接回报裸 outcome 字符串（agentAppService.handlePermissionResponse）。
 * 传输层故障（审批应答发送失败）直接 throw，走 handleApproval 的 catch。
 * storage_unavailable / PENDING_APPROVAL_STORAGE_UNAVAILABLE 是宿主活着、只是台账这次
 * 写不进的可重试中间态——运行没结束，不能说「已失效」，说「没生效，请重试」。
 */
// 与 parkedApprovalResume.ts ParkedApprovalResumeOutcome 的已落定状态对齐；未知值按失效处理（fail-closed）。
const RESUMED_SETTLED = new Set(['executed', 'denied', 'already_present']);

export function classifyPermissionDelivery(result: unknown): 'stale' | 'retryable' | 'ok' {
  if (typeof result === 'string') {
    if (result === 'delivered') return 'ok';
    return result === 'storage_unavailable' ? 'retryable' : 'stale';
  }
  if (typeof result !== 'object' || result === null) return 'ok';
  const record = result as { success?: unknown; outcome?: unknown; error?: unknown; resumed?: unknown };
  if (record.success === false) {
    const code = (record.error as { code?: unknown } | undefined)?.code;
    return code === 'PENDING_APPROVAL_STORAGE_UNAVAILABLE' ? 'retryable' : 'stale';
  }
  if (typeof record.resumed === 'string' && RESUMED_SETTLED.has(record.resumed)) return 'ok';
  if (typeof record.outcome === 'string' && record.outcome !== 'delivered') {
    return record.outcome === 'storage_unavailable' ? 'retryable' : 'stale';
  }
  return 'ok';
}
