import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  canClaimOrphanedCliLease,
  isAbandonedCliProcess,
} from '../../../../src/host/runtime/cliOrphanLease';

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid == null) throw new Error('spawned process has no pid');
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  return pid;
}

describe('cliOrphanLease', () => {
  it('does not treat a live cli pid or an unparseable id as abandoned', () => {
    expect(isAbandonedCliProcess(`cli-${process.pid}-live`)).toBe(false);
    expect(isAbandonedCliProcess(`cli-${process.pid}`)).toBe(false);
    expect(isAbandonedCliProcess('cli-dead')).toBe(false);
    expect(isAbandonedCliProcess(`web-${process.pid}-x`)).toBe(false);
  });

  it('treats an exited cli pid as abandoned even before lease expiry', async () => {
    const pid = await exitedPid();
    expect(isAbandonedCliProcess(`cli-${pid}-dead`)).toBe(true);
    expect(canClaimOrphanedCliLease(`cli-${pid}-dead`, 60_000, 3_000)).toBe(true);
  });

  it('allows claim after wall-clock expiry without process-death proof', () => {
    expect(canClaimOrphanedCliLease(`cli-${process.pid}-live`, 2_000, 3_000)).toBe(true);
    expect(canClaimOrphanedCliLease('cli-dead', 2_000, 3_000)).toBe(true);
  });

  it('refuses a live unexpired cli lease', () => {
    expect(canClaimOrphanedCliLease(`cli-${process.pid}-live`, 60_000, 3_000)).toBe(false);
  });
});
