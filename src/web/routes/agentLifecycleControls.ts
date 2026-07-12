import type { Router, Request, Response } from 'express';
import { AgentCancelBodySchema } from './agentBodySchemas';
import type { RunHandle } from '../../host/runtime/runContext';
import type { RunRegistry } from '../../host/runtime/runRegistry';
import type { DurableRunReadService } from '../../host/app/durableRunReadService';

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
  readService: DurableRunReadService | undefined,
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = AgentCancelBodySchema.safeParse(req.body ?? {});
  const requestedSessionId = parsed.success ? parsed.data.sessionId : undefined;
  if (requestedSessionId && readService) {
    const durableView = await readService.readNativeControl(requestedSessionId, () => {
      const legacy = runRegistry.getBySessionId(requestedSessionId);
      return {
        runId: legacy?.context.runId,
        status: legacy ? 'running' : 'idle',
        engine: legacy ? { kind: 'native' } : null,
      };
    });
    if (durableView.source === 'durable' && durableView.terminal) {
      res.status(409).json({
        success: false,
        error: { code: 'NO_ACTIVE_RUN', message: `Durable run is ${durableView.status}` },
      });
      return;
    }
  }
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
  readService?: DurableRunReadService,
): void {
  router.post('/pause', (req: Request, res: Response) => {
    void handleLifecycleControl('pause', runRegistry, readService, req, res);
  });

  router.post('/resume', (req: Request, res: Response) => {
    void handleLifecycleControl('resume', runRegistry, readService, req, res);
  });
}
