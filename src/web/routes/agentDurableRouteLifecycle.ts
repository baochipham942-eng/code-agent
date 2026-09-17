import type { Response } from 'express';
import type { AgentEngineRunResult } from '../../shared/contract/agentEngine';
import type { ExternalAgentEngineKind } from '../../shared/contract/agentEngine';
import type { SessionStatus } from '../../shared/contract';
import type { WorkspaceScope } from '../../shared/contract/project';
import type { DurableRunReadService } from '../../host/app/durableRunReadService';
import type { DurableRunRolloutPolicy } from '../../host/app/durableRunRollout';
import type { RunHandle } from '../../host/runtime/runContext';
import type { RunRegistry } from '../../host/runtime/runRegistry';
import { resolveWorkspacePath } from '../../host/runtime/workspaceScope';
import {
  ExternalEngineDurableLifecycle,
  type ExternalEngineTerminalStatus,
} from '../../host/services/agentEngine';
import type { WebRouteLogger } from './routeTypes';

export interface AgentDurableRouteDeps {
  getDurableRunRollout?: () => { policy: DurableRunRolloutPolicy; ready: boolean };
  getDurableRunReadService?: () => DurableRunReadService | undefined;
}

interface AgentDurableRouteRunLifecycleDeps {
  runRegistry: RunRegistry;
  sessionId: string;
  workspace: string;
  /**
   * 会话真实 Project 的 scope。传入后 native run 的写边界从 legacy 兜底升级为该项目，
   * 恢复时的 scope drift 判定也改为对项目库重derive。undefined = 维持 legacy 回落。
   */
  workspaceScope?: WorkspaceScope;
  durableActivation: boolean;
  externalEngine?: ExternalAgentEngineKind;
  externalSessionId?: string;
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
  private terminalStatus?: ExternalEngineTerminalStatus;
  private releasePromise?: Promise<void>;

  constructor(private readonly deps: AgentDurableRouteRunLifecycleDeps) {}

  start(): Promise<{
    runHandle: RunHandle;
    externalLifecycle?: ExternalEngineDurableLifecycle;
  }> {
    this.startPromise ??= this.startRun();
    return this.startPromise;
  }

  async markSuccess(input: AgentDurableRouteRunSuccess): Promise<ExternalEngineTerminalStatus> {
    if (this.terminalStatus) return this.terminalStatus;
    if ('result' in input) {
      this.terminalStatus = this.externalLifecycle
        ? await this.externalLifecycle.finish(
          input.result,
          input.result.status !== 'completed' || Boolean(input.result.outputText?.trim()),
        )
        : input.result.status === 'cancelled' ? 'cancelled' : input.result.status === 'failed' ? 'failed' : 'completed';
      this.terminal = true;
      return this.terminalStatus;
    }
    const finalStatus = input.finalStatus;
    const durableStatus: ExternalEngineTerminalStatus = finalStatus === 'completed'
      ? 'completed'
      : finalStatus === 'interrupted' ? 'cancelled' : 'failed';
    if (this.deps.durableActivation && this.runHandle) {
      await this.deps.runRegistry.terminalDurable(this.runHandle.context.runId, {
        now: Date.now(),
        status: durableStatus,
        reason: finalStatus,
        event: {
          type: `run_${finalStatus}`,
          payload: { sessionId: this.deps.sessionId },
          recordedAt: Date.now(),
        },
      }, this.runHandle);
    }
    this.terminalStatus = durableStatus;
    this.terminal = true;
    return durableStatus;
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
        this.terminalStatus = input.disconnected ? 'cancelled' : 'failed';
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
        this.terminalStatus = input.disconnected ? 'cancelled' : 'failed';
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
          externalSessionId: this.deps.externalSessionId,
        })
        : undefined;
      this.runHandle = this.externalLifecycle?.handle
        ?? this.deps.runRegistry.start({
          sessionId: this.deps.sessionId,
          workspace: this.deps.workspace,
        });
    } else {
      // durable 与非 durable 两支必须拿同一份写边界，否则同一会话里两种 run 权限面不一致。
      const nativeInput = {
        sessionId: this.deps.sessionId,
        workspace: this.deps.workspace,
        ...(this.deps.workspaceScope ? { workspaceScope: this.deps.workspaceScope } : {}),
        // cwd 显式钉在会话工作目录上：带 Project scope 时 RunContext.workspace 会
        // 取 scope.primaryRoot，不传 cwd 会把进程目录也挪到项目根。
        cwd: this.deps.workspace,
      };
      this.runHandle = this.deps.durableActivation
        ? await this.deps.runRegistry.startDurable(nativeInput)
        : this.deps.runRegistry.start(nativeInput);
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

/**
 * 会话的 WorkspaceScope 能不能钉成 web 路由 native run 的写边界（durable / 非 durable 共用）。
 *
 * - isolated Fork scope 不行：它的 version 是 `isolated-v1:` 派生串，恢复侧对项目库
 *   重derive 永远对不上，钉进去等于给每次重启预定一次 scope drift；这类会话维持
 *   legacy 兜底（恢复侧按 primaryRoot 重算，见 nativeRecoveryHost 端口）。
 * - 会话工作目录必须仍在 scope 界内：createRunContext 会拒绝界外 cwd，这里先降级
 *   回 legacy，别把一次普通发送变成 500。
 */
export function resolveNativeRunWorkspaceScope(input: {
  sessionScope?: WorkspaceScope;
  workspace: string;
}): WorkspaceScope | undefined {
  const { sessionScope } = input;
  if (!sessionScope) return undefined;
  if (sessionScope.version.startsWith('isolated-v1:')) return undefined;
  if (!resolveWorkspacePath(sessionScope, input.workspace, 'read')) return undefined;
  return sessionScope;
}

/**
 * agent/run 现在能不能接单——**唯一判据**。
 *
 * durable 就绪由 webServer 在本地 kernel 装配完成后设置；中断 run 的恢复仍可在
 * capabilityBootstrap 之后继续。/api/health 的 `durableRunReady` 与这里共用同一个
 * 谓词，别在两处各写一遍条件（写两遍必漂移）。
 */
export function isDurableRunGateOpen(
  rollout: { policy: DurableRunRolloutPolicy; ready: boolean } | undefined,
): boolean {
  return !(rollout?.policy.durableActivation && !rollout.ready);
}

export function resolveAgentDurableActivation(
  deps: AgentDurableRouteDeps,
  res: Response,
): boolean | null {
  const rollout = deps.getDurableRunRollout?.();
  if (!isDurableRunGateOpen(rollout)) {
    res.status(503).json({
      error: 'Durable Run persistence is unavailable',
      code: 'DURABLE_RUN_ROLLOUT_UNAVAILABLE',
      rolloutMode: rollout?.policy.mode,
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
  runId?: string;
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
  return view.source === 'durable'
    && view.terminal
    && (!input.runId || view.runId === input.runId);
}
