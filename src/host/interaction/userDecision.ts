import { IPC_CHANNELS } from '../../shared/ipc';
import type { AgentNoticeEvent } from '../../shared/ipc/handlers';

export const USER_INPUT_TIMEOUT_CODE = 'USER_INPUT_TIMEOUT';
const expiredDecisionRequests = new Map<string, string>();
const MAX_EXPIRED_REQUESTS = 200;

function formatMinutes(timeoutMs: number): string {
  return `${Math.ceil(timeoutMs / 60_000)} 分钟`;
}

/** 仅供无头短超时路径使用；交互 UI 路径不会展示这段文案。 */
export function headlessDecisionTimeoutReason(timeoutMs: number): string {
  return `等你决定超过 ${formatMinutes(timeoutMs)}，已按无头规则处理：未获人工确认，安全拒绝。`;
}

export function deniedDecisionMetadata(reason: string): {
  permissionDecision: 'deny';
  permissionDecisionReason: string;
} {
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  };
}

/** notificationService 内部负责“窗口聚焦时不发”，调用方每个请求只调用一次。 */
export function notifyDecisionNeeded(input: { sessionId?: string; title: string; body: string }): void {
  void import('../services/infra/notificationService')
    .then(({ notificationService }) => notificationService.notifyNeedsInput({
      sessionId: input.sessionId ?? '',
      title: input.title,
      body: input.body,
    }))
    .catch(() => undefined);
}

/** 请求已结算后收到旧卡应答，给当前可见 renderer 一条明确反馈。 */
function notifyLateDecisionResponse(kind: string): void {
  const event: AgentNoticeEvent = {
    reasonCode: 'interaction_response_expired',
    params: { kind },
  };
  void import('../platform/windowBridge')
    .then(({ broadcastToRenderer }) => broadcastToRenderer(IPC_CHANNELS.AGENT_NOTICE, event))
    .catch(() => undefined);
}

export function markDecisionRequestExpired(requestId: string, kind: string): void {
  expiredDecisionRequests.set(requestId, kind);
  if (expiredDecisionRequests.size > MAX_EXPIRED_REQUESTS) {
    const oldest = expiredDecisionRequests.keys().next().value;
    if (typeof oldest === 'string') expiredDecisionRequests.delete(oldest);
  }
}

export function clearExpiredDecisionRequest(requestId: string): void {
  expiredDecisionRequests.delete(requestId);
}

/** 只对本进程确实超时结算过的请求提示；普通未知/重复请求仍只记日志。 */
export function notifyIfLateDecisionResponse(requestId: string): boolean {
  const kind = expiredDecisionRequests.get(requestId);
  if (!kind) return false;
  expiredDecisionRequests.delete(requestId);
  notifyLateDecisionResponse(kind);
  return true;
}
