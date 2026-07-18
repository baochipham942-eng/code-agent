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

interface AgentDurableRouteRunLifecycleDeps {
  runRegistry: RunRegistry;
  sessionId: string;
  workspace: string;
  durableActivation: boolean;
  externalEngine?: ExternalAgentEngineKind;
  logger: WebRouteLogger;
}

type AgentDurableRouteRunSuccess =
  | { result: AgentEngineRunResult }
  | { finalStatus: SessionStatus };

class AgentDurableRouteRunLifecycle {
  private runHandle?: RunHandle;
  private externalLifecycle?: ExternalEngineDurableLifecycle;
  private startPromise?: Promise<{
    runHandle: RunHandle;
    externalLifecycle?: ExternalEngineDurableLifecycle;
  }>;
  private terminal = false;
  private releasePromise?: Promise<void>;

  constructor(private readonly deps: AgentDurableRouteRunLifecycleDeps) {}

  start(): Promise<{
    runHandle: RunHandle;
    externalLifecycle?: ExternalEngineDurableLifecycle;
  }> {
    this.startPromise ??= this.startRun();
    return this.startPromise;
  }

  async markSuccess(input: AgentDurableRouteRunSuccess): Promise<void> {
    if (this.terminal) return;
    if ('result' in input) {
      if (this.externalLifecycle) {
        await this.externalLifecycle.finish(
          input.result,
          input.result.status !== 'completed' || Boolean(input.result.outputText?.trim()),
        );
      }
      this.terminal = true;
      return;
    }
    if (this.deps.durableActivation && this.runHandle) {
      const finalStatus = input.finalStatus;
      await this.deps.runRegistry.terminalDurable(this.runHandle.context.runId, {
        now: Date.now(),
        status: finalStatus === 'completed'
          ? 'completed'
          : finalStatus === 'interrupted' ? 'cancelled' : 'failed',
        reason: finalStatus,
        event: {
          type: `run_${finalStatus}`,
          payload: { sessionId: this.deps.sessionId },
          recordedAt: Date.now(),
        },
      }, this.runHandle);
    }
    this.terminal = true;
  }

  async markFailure(input: { disconnected: boolean; message: string }): Promise<void> {
    if (this.externalLifecycle && !this.terminal) {
      try {
        await this.externalLifecycle.finish({
          runId: this.externalLifecycle.runId,
          sessionId: this.deps.sessionId,
          engine: this.externalLifecycle.engine,
          status: input.disconnected ? 'cancelled' : 'failed',
          error: input.message,
        }, true);
        this.terminal = true;
      } catch (error) {
        this.deps.logger.error('External Durable Run terminal commit failed:', error);
      }
    }
    if (this.runHandle && !this.terminal && this.deps.durableActivation) {
      try {
        await this.deps.runRegistry.terminalDurable(this.runHandle.context.runId, {
          now: Date.now(),
          status: input.disconnected ? 'cancelled' : 'failed',
          reason: input.message,
          event: {
            type: input.disconnected ? 'run_cancelled' : 'run_failed',
            payload: { message: input.message },
            recordedAt: Date.now(),
          },
        }, this.runHandle);
        this.terminal = true;
      } catch (error) {
        this.deps.logger.error('Durable Run terminal commit failed:', error);
      }
    }
  }

  release(): Promise<void> {
    this.releasePromise ??= this.releaseRun();
    return this.releasePromise;
  }

  private async startRun(): Promise<{
    runHandle: RunHandle;
    externalLifecycle?: ExternalEngineDurableLifecycle;
  }> {
    if (this.deps.externalEngine) {
      this.externalLifecycle = this.deps.durableActivation
        ? await ExternalEngineDurableLifecycle.start({
          registry: this.deps.runRegistry,
          engine: this.deps.externalEngine,
          sessionId: this.deps.sessionId,
          workspace: this.deps.workspace,
          cwd: this.deps.workspace,
        })
        : undefined;
      this.runHandle = this.externalLifecycle?.handle
        ?? this.deps.runRegistry.start({
          sessionId: this.deps.sessionId,
          workspace: this.deps.workspace,
        });
    } else {
      this.runHandle = this.deps.durableActivation
        ? await this.deps.runRegistry.startDurable({
          sessionId: this.deps.sessionId,
          workspace: this.deps.workspace,
        })
        : this.deps.runRegistry.start({
          sessionId: this.deps.sessionId,
          workspace: this.deps.workspace,
        });
    }
    return {
      runHandle: this.runHandle,
      externalLifecycle: this.externalLifecycle,
    };
  }

  private async releaseRun(): Promise<void> {
    if (!this.runHandle) return;
    if (!this.terminal && this.deps.durableActivation) {
      await this.deps.runRegistry.releaseDurable(this.runHandle.context.runId, this.runHandle);
    } else {
      this.deps.runRegistry.unregister(this.runHandle.context.runId, this.runHandle);
    }
  }
}

export function createAgentDurableRouteRunLifecycle(
  deps: AgentDurableRouteRunLifecycleDeps,
): AgentDurableRouteRunLifecycle {
  return new AgentDurableRouteRunLifecycle(deps);
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
