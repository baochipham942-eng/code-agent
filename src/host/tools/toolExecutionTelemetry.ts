import { createHash } from 'node:crypto';
import type { PermissionRequestData } from './types';
import { getTelemetryService } from '../telemetry/telemetryService';

function findToolSpan(toolCallId?: string) {
  return toolCallId
    ? getTelemetryService().findActiveSpanByAttribute('tool.call_id', toolCallId)
    : undefined;
}

export function annotateToolExecution(input: {
  toolCallId?: string;
  toolName: string;
  permissionClass: string;
  runId?: string;
  bridged: boolean;
}): void {
  try {
    const toolSpan = findToolSpan(input.toolCallId);
    if (!toolSpan) return;
    getTelemetryService().updateSpan(toolSpan.spanId, {
      'tool.source': input.bridged
        ? 'bridge'
        : /^mcp(__|_)/i.test(input.toolName) ? 'mcp' : 'protocol',
      'tool.permission_class': input.permissionClass,
      'tool.idempotency_key_digest': createHash('sha256')
        .update(`${input.runId ?? 'background'}:${input.toolCallId}`)
        .digest('hex')
        .slice(0, 24),
    });
  } catch {
    // Trace annotation is best-effort and never changes tool execution.
  }
}

// ============================================================================
// 等人审批的时间不算工具耗时
// ============================================================================
//
// 2026-07-26 真机：语音态审批改成「停车挂起」（不限时）后，用户还在看审批卡，界面已经
// 弹出「工具执行超时」——90s 那个阈值把**等人的时间**也算进了工具耗时。等人不是可疑，
// 卡在人身上的时间不该进这个钟。（顺带更正一条误读：那 90s 只是警告阈值，不是硬杀，
// 停车审批的真实兜底是 24h backstop，见 agentOrchestrator.parkApproval。）
//
// 记的是「到目前为止等了多久」，因为等待期间就要能被扣除——只在审批返回后累加的话，
// 停车挂起的那一整段照样会先把警告顶出来。
interface ApprovalWaitState {
  /** 已结束的等待累计（同一次工具调用可能问不止一次） */
  accumulatedMs: number;
  /** 正在等待中的那一段的起点；不在等待时为 undefined */
  waitingSince?: number;
}

const approvalWaits = new Map<string, ApprovalWaitState>();

/** 该工具调用到此刻为止花在「等人审批」上的毫秒数（含正在等待中的那一段）。 */
export function getApprovalWaitMs(toolCallId: string | undefined, now: number): number {
  if (!toolCallId) return 0;
  const state = approvalWaits.get(toolCallId);
  if (!state) return 0;
  return state.accumulatedMs + (state.waitingSince ? now - state.waitingSince : 0);
}

/** 工具调用收口时清账，避免 Map 随长会话无限长。 */
export function clearApprovalWait(toolCallId: string | undefined): void {
  if (toolCallId) approvalWaits.delete(toolCallId);
}

function beginApprovalWait(toolCallId: string | undefined): void {
  if (!toolCallId) return;
  const state = approvalWaits.get(toolCallId) ?? { accumulatedMs: 0 };
  state.waitingSince = Date.now();
  approvalWaits.set(toolCallId, state);
}

function endApprovalWait(toolCallId: string | undefined): void {
  if (!toolCallId) return;
  const state = approvalWaits.get(toolCallId);
  if (!state?.waitingSince) return;
  state.accumulatedMs += Date.now() - state.waitingSince;
  state.waitingSince = undefined;
}

export async function requestPermissionWithTelemetry(input: {
  request: PermissionRequestData;
  toolCallId?: string;
  requestPermission: (request: PermissionRequestData) => Promise<boolean>;
}): Promise<boolean> {
  let approvalSpanId: string | undefined;
  try {
    const toolSpan = findToolSpan(input.toolCallId);
    const approvalSpan = getTelemetryService().startSpan(
      'approval:tool',
      'approval',
      {
        'approval.kind': input.request.type,
        'approval.state': 'waiting',
      },
      toolSpan?.spanId,
    );
    approvalSpanId = approvalSpan.spanId;
    getTelemetryService().addSpanEvent(approvalSpan.spanId, 'approval.waiting');
  } catch {
    // Approval tracing is diagnostic only.
  }

  let approved: boolean;
  beginApprovalWait(input.toolCallId);
  try {
    approved = await input.requestPermission(input.request);
  } catch (error) {
    endApprovalWait(input.toolCallId);
    try {
      if (approvalSpanId) {
        getTelemetryService().endSpan(approvalSpanId, 'error', { 'approval.state': 'failed' });
      }
    } catch {
      // Approval tracing must not replace the permission error.
    }
    throw error;
  }
  endApprovalWait(input.toolCallId);

  try {
    if (approvalSpanId) {
      getTelemetryService().addSpanEvent(
        approvalSpanId,
        approved ? 'approval.resolved' : 'approval.rejected',
      );
      getTelemetryService().endSpan(approvalSpanId, approved ? 'ok' : 'cancelled', {
        'approval.state': approved ? 'resolved' : 'rejected',
      });
    }
  } catch {
    // Approval tracing is diagnostic only.
  }
  return approved;
}

export function markToolCacheHit(toolCallId?: string): void {
  try {
    const toolSpan = findToolSpan(toolCallId);
    if (toolSpan) getTelemetryService().updateSpan(toolSpan.spanId, { 'tool.cache_hit': true });
  } catch {
    // Trace storage is best-effort.
  }
}
