import { IPC_DOMAINS } from '@shared/ipc';
import type { LoopRunConfig, LoopRunState } from '@shared/contract/loop';

async function invokeLoop<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.LOOP, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `loop:${action} failed`);
  }
  return response.data as T;
}

export const loopClient = {
  start(config: LoopRunConfig) {
    return invokeLoop<LoopRunState>('start', config);
  },
  stop(id: string) {
    return invokeLoop<LoopRunState | null>('stop', { id });
  },
  list(sessionId?: string) {
    return invokeLoop<LoopRunState[]>('list', { sessionId });
  },
  get(id: string) {
    return invokeLoop<LoopRunState | null>('get', { id });
  },
};

export default loopClient;
