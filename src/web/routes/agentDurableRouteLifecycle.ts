import type { Response } from 'express';
import type { AgentEngineRunResult } from '../../shared/contract/agentEngine';
import type { ExternalAgentEngineKind } from '../../shared/contract/agentEngine';
import type { SessionStatus } from '../../shared/contract';
import type { DurableRunReadService } from '../../host/app/durableRunReadService';
import type { DurableRunRolloutPolicy } from '../../host/app/durableRunRollout';
import type { RunHandle } from '../../host/runtime/runContext';
import type { RunRegistry } from '../../host/runtime/runRegistry';
import { ExternalEngineDurableLifecycle } from '../../host/services/agentEngine';
import type { WebRouteLogger } from './routeTypes';

export interface AgentDurableRouteDeps {
  getDurableRunRollout?: () => { policy: DurableRunRolloutPolicy; ready: boolean };
  getDurableRunReadService?: () => DurableRunReadService | undefined;
}

export function resolveAgentDurableActivation(
  deps: AgentDurableRouteDeps,
  res: Response,
): boolean | null {
  const rollout = deps.getDurableRunRollout?.();
  if (rollout?.policy.durableActivation && !rollout.ready) {
    res.status(503).json({
      error: 'Durable Run persistence is unavailable',
      code: 'DURABLE_RUN_ROLLOUT_UNAVAILABLE',
      rolloutMode: rollout.policy.mode,
    });
    return null;
  }
  return rollout?.policy.durableActivation ?? true;
}

export async function startAgentRouteRun(input: {
  runRegistry: RunRegistry;
  sessionId: string;
  workspace: string;
  durableActivation: boolean;
  externalEngine?: ExternalAgentEngineKind;
}): Promise<{
  runHandle: RunHandle;
  externalLifecycle?: ExternalEngineDurableLifecycle;
}> {
  if (input.externalEngine) {
    const externalLifecycle = input.durableActivation
      ? await ExternalEngineDurableLifecycle.start({
        registry: input.runRegistry,
        engine: input.externalEngine,
        sessionId: input.sessionId,
        workspace: input.workspace,
        cwd: input.workspace,
      })
      : undefined;
    return {
      runHandle: externalLifecycle?.handle
        ?? input.runRegistry.start({ sessionId: input.sessionId, workspace: input.workspace }),
      externalLifecycle,
    };
  }
  return {
    runHandle: input.durableActivation
      ? await input.runRegistry.startDurable({ sessionId: input.sessionId, workspace: input.workspace })
      : input.runRegistry.start({ sessionId: input.sessionId, workspace: input.workspace }),
  };
}

export async function cancelDisconnectedAgentRouteRun(input: {
  runRegistry: RunRegistry;
  runHandle: RunHandle;
  sessionId: string;
  durableActivation: boolean;
}): Promise<void> {
  await input.runHandle.cancel('user');
  if (!input.durableActivation) {
    input.runRegistry.unregister(input.runHandle.context.runId, input.runHandle);
    return;
  }
  await input.runRegistry.terminalDurable(input.runHandle.context.runId, {
    now: Date.now(),
    status: 'cancelled',
    reason: 'client_disconnected_before_stream',
    event: { type: 'run_cancelled', payload: { sessionId: input.sessionId }, recordedAt: Date.now() },
  }, input.runHandle);
}

export async function finishExternalAgentRouteRun(
  lifecycle: ExternalEngineDurableLifecycle | undefined,
  result: AgentEngineRunResult,
): Promise<boolean> {
  if (!lifecycle) return true;
  await lifecycle.finish(result, result.status !== 'completed' || Boolean(result.outputText?.trim()));
  return true;
}

export async function terminalAgentRouteRunSuccess(input: {
  runRegistry: RunRegistry;
  runHandle: RunHandle;
  sessionId: string;
  finalStatus: SessionStatus;
  durableActivation: boolean;
}): Promise<boolean> {
  if (!input.durableActivation) return true;
  await input.runRegistry.terminalDurable(input.runHandle.context.runId, {
    now: Date.now(),
    status: input.finalStatus === 'completed'
      ? 'completed'
      : input.finalStatus === 'interrupted' ? 'cancelled' : 'failed',
    reason: input.finalStatus,
    event: {
      type: `run_${input.finalStatus}`,
      payload: { sessionId: input.sessionId },
      recordedAt: Date.now(),
    },
  }, input.runHandle);
  return true;
}

export async function terminalAgentRouteRunFailure(input: {
  runRegistry: RunRegistry;
  runHandle?: RunHandle;
  externalLifecycle?: ExternalEngineDurableLifecycle;
  terminal: boolean;
  durableActivation: boolean;
  disconnected: boolean;
  sessionId: string;
  message: string;
  logger: WebRouteLogger;
}): Promise<boolean> {
  let terminal = input.terminal;
  if (input.externalLifecycle && !terminal) {
    try {
      await input.externalLifecycle.finish({
        runId: input.externalLifecycle.runId,
        sessionId: input.sessionId,
        engine: input.externalLifecycle.engine,
        status: input.disconnected ? 'cancelled' : 'failed',
        error: input.message,
      }, true);
      terminal = true;
    } catch (error) {
      input.logger.error('External Durable Run terminal commit failed:', error);
    }
  }
  if (input.runHandle && !terminal && input.durableActivation) {
    try {
      await input.runRegistry.terminalDurable(input.runHandle.context.runId, {
        now: Date.now(),
        status: input.disconnected ? 'cancelled' : 'failed',
        reason: input.message,
        event: { type: 'run_failed', payload: { message: input.message }, recordedAt: Date.now() },
      }, input.runHandle);
      terminal = true;
    } catch (error) {
      input.logger.error('Durable Run terminal commit failed:', error);
    }
  }
  return terminal;
}

export async function releaseAgentRouteRun(input: {
  runRegistry: RunRegistry;
  runHandle?: RunHandle;
  terminal: boolean;
  durableActivation: boolean;
}): Promise<void> {
  if (!input.runHandle) return;
  if (!input.terminal && input.durableActivation) {
    await input.runRegistry.releaseDurable(input.runHandle.context.runId, input.runHandle);
  } else {
    input.runRegistry.unregister(input.runHandle.context.runId, input.runHandle);
  }
}

export async function isDurableTerminalNativeControl(input: {
  readService?: DurableRunReadService;
  runRegistry: RunRegistry;
  sessionId?: string;
}): Promise<boolean> {
  if (!input.sessionId || !input.readService) return false;
  const view = await input.readService.readNativeControl(input.sessionId, () => {
    const legacy = input.runRegistry.getBySessionId(input.sessionId!);
    return {
      runId: legacy?.context.runId,
      status: legacy ? 'running' : 'idle',
      engine: { kind: 'native' },
    };
  });
  return view.source === 'durable' && view.terminal;
}
