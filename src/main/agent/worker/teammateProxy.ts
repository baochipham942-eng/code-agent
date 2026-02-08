// ============================================================================
// Teammate Proxy - Phase 2 进程隔离（Stub）
// ============================================================================

import type { AgentWorkerManager } from './agentWorkerManager';

export class TeammateProxy {
  constructor(_workerManager: AgentWorkerManager) {}

  flushQueue(_workerId: string): void {
    // Stub
  }

  reset(): void {
    // Stub
  }
}
