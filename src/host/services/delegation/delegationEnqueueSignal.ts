let enqueueSignal: ((sessionId: string) => void) | null = null;

export function setDelegationEnqueueSignal(signal: ((sessionId: string) => void) | null): void {
  enqueueSignal = signal;
}

export function notifyDelegationEnqueued(sessionId: string): void {
  enqueueSignal?.(sessionId);
}
