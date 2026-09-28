import type { Router } from 'express';
import type { Message } from '../../shared/contract';
import type { TaskManager } from '../../host/task';
import { getTaskManager as getDefaultTaskManager } from '../../host/task/TaskManager';
import { continueParkedDurableRun } from '../../host/app/durableRunContinuation';
import type { RunRegistry } from '../../host/runtime/runRegistry';
import { formatError } from '../helpers/utils';
import { AgentContinueBodySchema } from './agentBodySchemas';

export function registerAgentContinueRoute(
  router: Router,
  runRegistry: RunRegistry,
  getTaskManager: () => TaskManager = getDefaultTaskManager,
  getMessages?: (sessionId: string) => Promise<Message[]>,
): void {
  router.post('/continue', async (req, res) => {
    const parsedBody = AgentContinueBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res.status(400).json({ success: false, error: { code: 'INVALID_PAYLOAD', message: 'Missing sessionId' } });
      return;
    }

    try {
      const result = await continueParkedDurableRun({
        sessionId: parsedBody.data.sessionId,
        runRegistry,
        taskManager: getTaskManager(),
        ...(getMessages ? { getMessages } : {}),
      });
      res.json({ success: true, data: result });
    } catch (error) {
      const message = formatError(error);
      const status = message.includes('already continuing') || message.includes('already running')
        || message.includes('No parked durable run')
        ? 409
        : 500;
      res.status(status).json({
        success: false,
        error: { code: 'CONTINUE_FAILED', message },
      });
    }
  });
}
