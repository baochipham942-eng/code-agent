import type { Router } from 'express';
import type { DurableRunReadService } from '../../host/app/durableRunReadService';
import type { RunRegistry } from '../../host/runtime/runRegistry';
import { CANCELLATION_TIMEOUTS } from '../../shared/constants';
import { AgentCancelBodySchema } from './agentBodySchemas';
import { isDurableTerminalNativeControl } from './agentDurableRouteLifecycle';

async function waitForCancelSettlement(input: {
  runId: string;
  sessionId: string;
  runRegistry: RunRegistry;
  readService?: DurableRunReadService;
  timeoutMs: number;
  pollMs: number;
}): Promise<'settled' | 'timeout'> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (!input.runRegistry.get(input.runId)) {
      return 'settled';
    }
    if (input.readService) {
      const terminal = await isDurableTerminalNativeControl({
        readService: input.readService,
        runRegistry: input.runRegistry,
        sessionId: input.sessionId,
      });
      if (terminal) {
        return 'settled';
      }
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollMs));
  }
  return input.runRegistry.get(input.runId) ? 'timeout' : 'settled';
}

export function registerAgentCancelRoute(
  router: Router,
  runRegistry: RunRegistry,
  getReadService?: () => DurableRunReadService | undefined,
): void {
  router.post('/cancel', async (req, res) => {
    const parsedBody = AgentCancelBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res.status(400).json({ error: 'Invalid cancel target', code: 'INVALID_PAYLOAD' });
      return;
    }
    const { runId, sessionId } = parsedBody.data;
    if (await isDurableTerminalNativeControl({
      readService: getReadService?.(),
      runRegistry,
      sessionId,
    })) {
      res.json({ message: 'No active agent to cancel' });
      return;
    }
    const target = runRegistry.resolve({ runId, sessionId });
    if (!target) {
      const ambiguous = !runId && !sessionId && runRegistry.size > 1;
      res.status(ambiguous ? 409 : 200).json({
        message: ambiguous
          ? 'runId or sessionId is required when multiple runs are active'
          : 'No active agent to cancel',
        ...(ambiguous ? { code: 'RUN_TARGET_REQUIRED' } : {}),
      });
      return;
    }

    await target.cancel('user');

    // Honest response: only claim "Cancelled" after the run left the active set
    // (registry unregister) or durable facts report terminal. Primary consumer
    // (renderer cancel) optimistically clears UI on invoke success — waiting for
    // real settlement keeps that contract truthful. On timeout return
    // cancel_requested so callers can keep polling instead of being lied to.
    const settlement = await waitForCancelSettlement({
      runId: target.context.runId,
      sessionId: target.context.sessionId,
      runRegistry,
      readService: getReadService?.(),
      timeoutMs: CANCELLATION_TIMEOUTS.ROUTE_SETTLE_WAIT,
      pollMs: CANCELLATION_TIMEOUTS.ROUTE_SETTLE_POLL,
    });

    if (settlement === 'settled') {
      res.json({
        message: 'Cancelled',
        runId: target.context.runId,
        sessionId: target.context.sessionId,
      });
      return;
    }

    res.status(202).json({
      message: 'cancel_requested',
      code: 'CANCEL_REQUESTED',
      runId: target.context.runId,
      sessionId: target.context.sessionId,
    });
  });
}
