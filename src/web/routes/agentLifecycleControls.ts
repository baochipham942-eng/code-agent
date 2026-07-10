import type { Router, Request, Response } from 'express';
import { AgentCancelBodySchema } from './agentBodySchemas';
import type { RunHandle } from '../../host/runtime/runContext';
import type { RunRegistry } from '../../host/runtime/runRegistry';

type LifecycleAction = 'pause' | 'resume';

function resolveActiveLoop(
  runRegistry: RunRegistry,
  body: unknown,
): RunHandle | null {
  const parsedBody = AgentCancelBodySchema.safeParse(body ?? {});
  if (!parsedBody.success) return null;
  return runRegistry.resolve(parsedBody.data) ?? null;
}

async function handleLifecycleControl(
  action: LifecycleAction,
  runRegistry: RunRegistry,
  req: Request,
  res: Response,
): Promise<void> {
  const target = resolveActiveLoop(runRegistry, req.body);
  if (!target?.isAttached || target.cancellationRequested) {
    res.status(409).json({
      success: false,
      error: {
        code: 'NO_ACTIVE_RUN',
        message: `No active agent to ${action}`,
      },
    });
    return;
  }

  try {
    await target[action]();
  } catch (error) {
    res.status(409).json({
      success: false,
      error: {
        code: `${action.toUpperCase()}_UNSUPPORTED`,
        message: error instanceof Error ? error.message : `Active agent does not support ${action}`,
      },
    });
    return;
  }
  res.json({
    success: true,
    data: {
      message: action === 'pause' ? 'Paused' : 'Resumed',
      runId: target.context.runId,
      sessionId: target.context.sessionId,
    },
  });
}

export function registerAgentLifecycleControlRoutes(
  router: Router,
  runRegistry: RunRegistry,
): void {
  router.post('/pause', (req: Request, res: Response) => {
    void handleLifecycleControl('pause', runRegistry, req, res);
  });

  router.post('/resume', (req: Request, res: Response) => {
    void handleLifecycleControl('resume', runRegistry, req, res);
  });
}
