import type { ChildProcess } from 'node:child_process';

const TREE_EXIT_CONFIRM_MS = 2_000;
const TREE_POLL_MS = 25;

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function signalGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

async function waitUntil(deadline: number, predicate: () => boolean): Promise<boolean> {
  while (predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => { setTimeout(resolve, TREE_POLL_MS); });
  }
  return true;
}

/** Terminate the detached evaluation process group and confirm that no descendant remains. */
export async function terminateEvalProcessTree(
  child: ChildProcess,
  graceMs: number,
): Promise<void> {
  const pid = child.pid;
  if (!pid || !processGroupAlive(pid)) return;

  signalGroup(child, pid, 'SIGTERM');
  if (await waitUntil(Date.now() + graceMs, () => processGroupAlive(pid))) return;

  signalGroup(child, pid, 'SIGKILL');
  if (await waitUntil(Date.now() + TREE_EXIT_CONFIRM_MS, () => processGroupAlive(pid))) return;
  throw new Error(`Evaluation process group ${pid} did not exit.`);
}
