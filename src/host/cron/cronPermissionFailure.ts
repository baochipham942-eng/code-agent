import { exec } from 'child_process';
import { promisify } from 'util';

export const execAsync = promisify(exec);

export function structuredErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function unattendedPermissionFailureError(
  failure: { code: string; message: string; requestId: string; tool: string },
): Error {
  return Object.assign(new Error(failure.message), {
    code: failure.code,
    requestId: failure.requestId,
    tool: failure.tool,
  });
}

interface UnattendedPermissionFailureSource {
  consumeUnattendedPermissionFailure(): {
    code: string;
    message: string;
    requestId: string;
    tool: string;
  } | null;
}

export function throwIfUnattendedPermissionFailed(source: UnattendedPermissionFailureSource): void {
  const failure = source.consumeUnattendedPermissionFailure();
  if (failure) throw unattendedPermissionFailureError(failure);
}

export function preferUnattendedPermissionFailure(
  source: UnattendedPermissionFailureSource,
  fallback: unknown,
): unknown {
  const failure = source.consumeUnattendedPermissionFailure();
  return failure ? unattendedPermissionFailureError(failure) : fallback;
}
