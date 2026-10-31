import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from './ipcService';

type PermissionClickStage =
  | 'swallowed:no-request-or-settled'
  | 'swallowed:already-processed'
  | 'swallowed:claim-rejected'
  | 'undelivered'
  | 'card-catch'
  | 'transport-send-failure';

function permissionClickErrorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  if (typeof error === 'string') return error.slice(0, 300);
  if (typeof error === 'object' && error !== null) {
    const hostCode = (error as { error?: { code?: unknown } }).error?.code;
    if (typeof hostCode === 'string') return hostCode.slice(0, 300);
    const outcome = (error as { outcome?: unknown }).outcome;
    if (typeof outcome === 'string') return outcome.slice(0, 300);
  }
  return error === undefined || error === null ? '' : String(error).slice(0, 300);
}

export function logPermissionClickExit({
  requestId,
  stage,
  sessionId,
  error,
}: {
  requestId?: string | null;
  stage: PermissionClickStage;
  sessionId?: string | null;
  error?: unknown;
}): void {
  const message = `PermissionCard click exit: stage=${stage} requestId=${requestId ?? 'none'} sessionId=${sessionId ?? 'none'}`;
  try {
    void ipcService.invokeDomain(IPC_DOMAINS.DIAGNOSTICS, 'logClientError', {
      context: 'PermissionCard',
      message,
      detail: permissionClickErrorText(error),
    }).catch(() => {});
  } catch {
    return;
  }
}
