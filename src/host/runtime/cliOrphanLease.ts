/**
 * CLI processInstanceId is `cli-${pid}` or `cli-${pid}-${uuid}`.
 * A live lease may still be claimed when that pid is gone (ESRCH).
 * Unknown shapes are not proof of death.
 */
const CLI_PROCESS_INSTANCE = /^cli-(\d+)(?:-|$)/;

export function isAbandonedCliProcess(processInstanceId: string): boolean {
  const pid = parseCliOwnerPid(processInstanceId);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export function canClaimOrphanedCliLease(
  processInstanceId: string,
  leaseExpiresAt: number | undefined,
  now: number,
): boolean {
  if ((leaseExpiresAt ?? 0) <= now) return true;
  return isAbandonedCliProcess(processInstanceId);
}

function parseCliOwnerPid(processInstanceId: string): number | null {
  const match = CLI_PROCESS_INSTANCE.exec(processInstanceId);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
