const queued = new Set<string>();
const running = new Set<string>();

export function markDurableResumeQueued(runId: string): void {
  queued.add(runId);
  running.delete(runId);
}

export function markDurableResumeStarted(runId: string): void {
  queued.delete(runId);
  running.add(runId);
}

export function clearDurableResumeState(runId: string): void {
  queued.delete(runId);
  running.delete(runId);
}

export function isDurableResumeQueued(runId: string | null): boolean {
  return runId !== null && queued.has(runId);
}
