import { execFileSync } from 'node:child_process';

type PortCleanupOptions = {
  currentPid?: string;
  exec?: (file: string, args: string[]) => string;
  log?: (message: string) => void;
  wait?: (ms: number) => Promise<void>;
};

const defaultExec = (file: string, args: string[]): string => (
  execFileSync(file, args, { encoding: 'utf-8' })
);

function readCommand(pid: string, exec: (file: string, args: string[]) => string): string {
  try {
    return exec('ps', ['-p', pid, '-o', 'command=']).trim() || '<command unavailable>';
  } catch {
    return '<command unavailable>';
  }
}

/** Kill any process holding the target port (zombie node processes from previous runs). */
export async function killPortHolder(port: number, {
  currentPid = process.pid.toString(),
  exec = defaultExec,
  log = console.log,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: PortCleanupOptions = {}): Promise<void> {
  try {
    const pids = exec('lsof', ['-ti', `:${port}`]).trim();
    if (!pids) return;

    const targetPids = pids.split('\n').filter((pid) => pid !== currentPid && /^\d+$/.test(pid));
    if (targetPids.length === 0) return;

    for (const pid of targetPids) {
      log(`  Killing zombie process on port ${port}: PID ${pid}, command: ${readCommand(pid, exec)}`);
    }
    exec('kill', ['-9', ...targetPids]);

    // Brief wait for OS to release the port.
    await wait(300);
  } catch {
    // lsof returns exit code 1 when no match — port is free.
  }
}
