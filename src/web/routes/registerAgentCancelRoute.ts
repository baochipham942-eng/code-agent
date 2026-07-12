import type { Router } from 'express';
import type { DurableRunReadService } from '../../host/app/durableRunReadService';
import type { RunRegistry } from '../../host/runtime/runRegistry';
import { AgentCancelBodySchema } from './agentBodySchemas';
import { isDurableTerminalNativeControl } from './agentDurableRouteLifecycle';

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
    res.json({
      message: 'Cancelled',
      runId: target.context.runId,
      sessionId: target.context.sessionId,
    });
  });
}
