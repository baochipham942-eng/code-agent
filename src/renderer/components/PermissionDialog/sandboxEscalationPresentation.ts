import { redactCredentialText } from '@shared/security/secretPatterns';
import type { PermissionRequest } from './types';
import { formatFilePath } from './utils';

const SANDBOX_ESCALATION_ACTIONS = new Set([
  'sandbox_escalate_once',
  'sandbox_escalate_dir_once',
]);

/** 文件与目录两张沙盒放宽卡共用这一判据。 */
export function isSandboxEscalation(request: Pick<PermissionRequest, 'details'>): boolean {
  const action = request.details.action;
  return typeof action === 'string' && SANDBOX_ESCALATION_ACTIONS.has(action);
}

/** 问句用宿主 reason 原文；空 reason 才退回通用问句。 */
export function sandboxEscalationQuestion(reason: string | undefined, fallback: string): string {
  if (typeof reason === 'string' && reason.trim().length > 0) return reason;
  return fallback;
}

/** 被拦路径单独一行，脱敏口径与其他路径相同。 */
export function sandboxEscalationDeniedPath(request: Pick<PermissionRequest, 'details'>): string | undefined {
  const deniedPath = request.details.deniedPath;
  if (!deniedPath) return undefined;
  return formatFilePath(redactCredentialText(deniedPath));
}
