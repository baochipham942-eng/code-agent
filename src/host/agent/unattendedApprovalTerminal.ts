/** 无人值守审批超时写进执行记录的原因码。交互会话不使用这条。 */
export const UNATTENDED_APPROVAL_TIMEOUT = 'UNATTENDED_APPROVAL_TIMEOUT';

const pending = new Map<string, string>();

/** 仅兼容显式旧 60s 终态会话；新的 cron/heartbeat 走 24h 停车，不写这条原因码。 */
export function noteUnattendedApprovalTimeout(sessionId: string): void {
  noteUnattendedRunTerminal(sessionId, UNATTENDED_APPROVAL_TIMEOUT);
}

/** 无人值守运行的终态原因码。后写覆盖先写；cron 收尾时取走。 */
export function noteUnattendedRunTerminal(sessionId: string, code: string): void {
  pending.set(sessionId, code);
}

/** 取出并清掉该会话的超时原因码。没有则 undefined。 */
export function takeUnattendedApprovalTimeout(sessionId: string): string | undefined {
  const code = pending.get(sessionId);
  if (code) pending.delete(sessionId);
  return code;
}

/** 降级拒绝（30 分钟无人批准）的执行留痕：run 照常完成，只记下哪一步没被批准。 */
export interface UnattendedApprovalDenial {
  tool: string;
  argsPreview?: string;
  requestedAt: number;
  code: string;
}

const denials = new Map<string, UnattendedApprovalDenial[]>();

export function noteUnattendedApprovalDenial(sessionId: string, denial: UnattendedApprovalDenial): void {
  denials.set(sessionId, [...(denials.get(sessionId) ?? []), denial]);
}

export function takeUnattendedApprovalDenials(sessionId: string): UnattendedApprovalDenial[] {
  const list = denials.get(sessionId) ?? [];
  denials.delete(sessionId);
  return list;
}

/** 给模型看的降级拒绝说明：不重试、继续其他来源、最终报告点名。 */
export function buildUnattendedDegradeFeedback(tool: string, waitedMs: number): string {
  return `${UNATTENDED_APPROVAL_TIMEOUT}: 工具 ${tool} 的审批等了 ${Math.round(waitedMs / 60_000)} 分钟仍无人批准（当前无人在场），已自动拒绝。`
    + '不要重试这一步；继续处理其他来源，并在最终报告里写明「未读取：<来源>（需要你批准）」。';
}
