// ============================================================================
// agent:notice 广播（从 agentOrchestrator.ts 逐字搬出，N-MAXLINES-MINEFIELD-2-FU1-S2）
// ============================================================================

import { IPC_CHANNELS } from '../../../shared/ipc';
import type { AgentNoticeEvent } from '../../../shared/ipc/handlers';

/**
 * agent:notice 广播（比照 inferenceProviderFallback.ts 的 broadcastAiSdkProviderFallback）。
 * 动态 import windowBridge，best-effort，不影响主链路。
 */
export async function broadcastAgentNotice(event: AgentNoticeEvent): Promise<void> {
  try {
    const { broadcastToRenderer } = await import('../../platform/windowBridge');
    broadcastToRenderer?.(IPC_CHANNELS.AGENT_NOTICE, event);
  } catch {
    /* toast 是 best-effort，不影响主链路 */
  }
}
