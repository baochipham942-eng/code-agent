/** 无人值守审批超时写进执行记录的原因码。交互会话不使用这条。 */
export const UNATTENDED_APPROVAL_TIMEOUT = 'UNATTENDED_APPROVAL_TIMEOUT';

const pending = new Map<string, string>();

/** cron/heartbeat 会话的审批超时。语音派不记。 */
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
