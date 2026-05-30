import type { Router, Request, Response } from 'express';
import type { ActiveAgentLoop } from './agent';
import { AgentCancelBodySchema } from './agentBodySchemas';

type LifecycleAction = 'pause' | 'resume';

function resolveActiveLoop(
  activeAgentLoops: Map<string, ActiveAgentLoop>,
  body: unknown,
): { sessionId: string; loop: ActiveAgentLoop } | null {
  const parsedBody = AgentCancelBodySchema.safeParse(body);
  const requestedSessionId = parsedBody.success ? parsedBody.data.sessionId : undefined;
  const activeLoopEntry = requestedSessionId
    ? [requestedSessionId, activeAgentLoops.get(requestedSessionId)] as const
    : [...activeAgentLoops.entries()].at(-1);
  const sessionId = activeLoopEntry?.[0];
  const loop = activeLoopEntry?.[1];
  return sessionId && loop ? { sessionId, loop } : null;
}

async function handleLifecycleControl(
  action: LifecycleAction,
  activeAgentLoops: Map<string, ActiveAgentLoop>,
  req: Request,
  res: Response,
): Promise<void> {
  const target = resolveActiveLoop(activeAgentLoops, req.body);
  if (!target) {
    res.status(409).json({
      success: false,
      error: {
        code: 'NO_ACTIVE_RUN',
        message: `No active agent to ${action}`,
      },
    });
    return;
  }

  const fn = target.loop[action];
  if (typeof fn !== 'function') {
    res.status(409).json({
      success: false,
      error: {
        code: `${action.toUpperCase()}_UNSUPPORTED`,
        message: `Active agent does not support ${action}`,
      },
    });
    return;
  }

  await Promise.resolve(fn.call(target.loop));
  res.json({
    success: true,
    data: {
      message: action === 'pause' ? 'Paused' : 'Resumed',
      sessionId: target.sessionId,
    },
  });
}

export function registerAgentLifecycleControlRoutes(
  router: Router,
  activeAgentLoops: Map<string, ActiveAgentLoop>,
): void {
  router.post('/pause', (req: Request, res: Response) => {
    void handleLifecycleControl('pause', activeAgentLoops, req, res);
  });

  router.post('/resume', (req: Request, res: Response) => {
    void handleLifecycleControl('resume', activeAgentLoops, req, res);
  });
}
