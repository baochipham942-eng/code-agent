import type { PermissionAskResult } from '../../shared/contract/permission';

const E2E_APPROVAL_POLICY = 'e2e-scripted-allow';

function readApprovalPolicy(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>).approvalPolicy;
}

export function getDevCancellableToolPermissionHandler(
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
): (() => Promise<PermissionAskResult>) | undefined {
  if (readApprovalPolicy(body) !== E2E_APPROVAL_POLICY || env.CODE_AGENT_E2E !== '1') {
    return undefined;
  }
  return async () => ({ approved: true, approvalSource: 'scripted' });
}
