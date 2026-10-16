import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import {
  CuaStateAdapter,
  type CuaStatefulComputerUseRequest,
  type CuaStatefulExecutionResult,
} from '../../../mcp/cuaStateAdapter';
import { CuaMcpDriverPort } from '../../../mcp/cuaMcpDriverPort';
import { subscribeCuaInputLockLifecycle } from '../../../mcp/cuaSessionLock';
import {
  cuaStatefulComputerUseSchema as schema,
  withCuaJevStepOperation,
} from './cuaStatefulComputerUse.schema';
import {
  cuaJevStepEmptyTaskResult,
  cuaJevStepUnarmedResult,
  resolveCuaJevStep,
  type CuaJevStepDriver,
  type CuaJevStepDispatch,
} from '../../../agent/runtime/desktop/jevCuaStep';
import type {
  ComputerUseExpectationV1,
  ComputerUseMutationV1,
} from '../../../../shared/contract/desktop';
import type { SurfaceRuntimeIdentityV1 } from '../../../services/surfaceExecution/SurfaceExecutionRuntime';
import {
  getSurfaceExecutionRuntime,
  type SurfaceExecutionRuntime,
} from '../../../services/surfaceExecution/SurfaceExecutionRuntime';
import { SurfaceExecutionRuntimeError } from '../../../services/surfaceExecution/SurfaceExecutionRuntimeError';
import { surfaceProofService } from '../../../services/surfaceExecution/SurfaceProofService';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** execute_goal 是 Jev 步选环的入口（N-JEV-CU-STEP-LOOP）；适配器请求类型不收它。 */
interface CuaExecuteGoalRequest {
  operation: 'execute_goal';
  task: string;
  target?: { pid: number; windowId: number };
  jevBudgetUsd?: number;
}

type CuaToolRequest = CuaStatefulComputerUseRequest | CuaExecuteGoalRequest;

function parseRequest(args: Record<string, unknown>): CuaToolRequest {
  if (args.operation === 'list_roots') {
    return { operation: 'list_roots', onScreenOnly: args.onScreenOnly === true };
  }
  if (args.operation === 'observe') {
    if (!isRecord(args.target)) throw new Error('observe requires target');
    return {
      operation: 'observe',
      target: {
        pid: args.target.pid as number,
        windowId: args.target.windowId as number,
      },
      ...(typeof args.query === 'string' ? { query: args.query } : {}),
      ...(typeof args.includeScreenshot === 'boolean'
        ? { includeScreenshot: args.includeScreenshot }
        : {}),
      ...(typeof args.maxElements === 'number' ? { maxElements: args.maxElements } : {}),
      ...(typeof args.maxDepth === 'number' ? { maxDepth: args.maxDepth } : {}),
    };
  }
  if (args.operation === 'act') {
    if (typeof args.stateId !== 'string' || !isRecord(args.mutation)) {
      throw new Error('act requires stateId and mutation');
    }
    return {
      operation: 'act',
      stateId: args.stateId,
      mutation: args.mutation as unknown as ComputerUseMutationV1,
      ...(isRecord(args.expect)
        ? { expect: args.expect as unknown as ComputerUseExpectationV1 }
        : {}),
    };
  }
  if (args.operation === 'execute_goal') {
    const target = isRecord(args.target)
      ? {
        pid: args.target.pid as number,
        windowId: args.target.windowId as number,
      }
      : undefined;
    return {
      operation: 'execute_goal',
      task: typeof args.task === 'string' ? args.task : '',
      ...(target ? { target } : {}),
      ...(typeof args.jevBudgetUsd === 'number' ? { jevBudgetUsd: args.jevBudgetUsd } : {}),
    };
  }
  throw new Error('operation must be list_roots, observe, act, or execute_goal');
}

function runtimeIdentity(ctx: ToolContext): SurfaceRuntimeIdentityV1 | null {
  const runId = ctx.runId?.trim();
  const agentId = ctx.agentId?.trim();
  if (!runId || !agentId) return null;
  return {
    conversationId: ctx.sessionId,
    runId,
    ...(ctx.turnId?.trim() ? { turnId: ctx.turnId.trim() } : {}),
    agentId,
    emitSurfaceEvent: (event) => ctx.emit({ type: 'surface_execution', data: event }),
  };
}

function resultMeta(execution: CuaStatefulExecutionResult): Record<string, unknown> {
  const response = execution.response;
  const state = response.operation === 'observe'
    ? response.state
    : response.operation === 'act'
      ? response.result.successorState
      : undefined;
  return {
    computerUseStateV1: state,
    ...(response.operation === 'act' ? { computerUseActionResultV1: response.result } : {}),
    ...(execution.imageDataUrl ? { imageBase64: execution.imageDataUrl } : {}),
  };
}

export class CuaStatefulComputerUseHandler
implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  private readonly stateApps = new Map<string, { appName: string; expiresAtMs: number }>();

  constructor(
    private readonly adapter = new CuaStateAdapter(new CuaMcpDriverPort()),
    private readonly surfaceRuntime: SurfaceExecutionRuntime = getSurfaceExecutionRuntime(),
    private readonly jevStepFactory: (dispatch: CuaJevStepDispatch) => CuaJevStepDriver | undefined = (dispatch) => resolveCuaJevStep(dispatch),
  ) {}

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    let request: CuaToolRequest;
    try {
      if ((args.operation === 'observe' || args.operation === 'act')
        && (typeof args.targetApp !== 'string' || !args.targetApp.trim())) {
        throw new Error('observe and act require targetApp: use the appName shown by list_roots.');
      }
      request = parseRequest(args);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'INVALID_ARGS',
      };
    }
    if (request.operation === 'execute_goal') {
      return this.executeGoal(request, ctx, canUseTool);
    }
    return this.runOperation(args, request, ctx, canUseTool, onProgress);
  }

  /**
   * N-JEV-CU-STEP-LOOP：execute_goal 进 Jev 步选环。环内每个 act 都经
   * runOperation（含 canUseTool 审批与 Surface 绑定）发回本 handler，环不直连
   * 适配器；风险升级只把审批升到 forceConfirm，Jev 无权发放许可。
   */
  private async executeGoal(
    request: CuaExecuteGoalRequest,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
  ): Promise<ToolResult<string>> {
    if (!request.task.trim()) return cuaJevStepEmptyTaskResult();
    const identity = runtimeIdentity(ctx);
    if (!identity) {
      return {
        ok: false,
        error: 'execute_goal requires explicit runId and agentId ownership.',
        code: 'SURFACE_TARGET_NOT_OWNED',
      };
    }
    const dispatch: CuaJevStepDispatch = async (actArgs, gate) => {
      const parsed = parseRequest(actArgs);
      if (parsed.operation === 'execute_goal') {
        throw new Error('cua jev step loop must not dispatch execute_goal');
      }
      return this.runOperation(actArgs, parsed, ctx, canUseTool, undefined, gate);
    };
    const driver = this.jevStepFactory(dispatch);
    if (!driver) return cuaJevStepUnarmedResult();
    return driver.run(
      {
        task: request.task,
        ...(request.target ? { target: request.target } : {}),
        ...(request.jevBudgetUsd !== undefined ? { jevBudgetUsd: request.jevBudgetUsd } : {}),
      },
      ctx,
    );
  }

  private async runOperation(
    args: Record<string, unknown>,
    request: CuaStatefulComputerUseRequest,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress: ToolProgressFn | undefined,
    gate?: { forceConfirm?: boolean },
  ): Promise<ToolResult<string>> {
    const identity = runtimeIdentity(ctx);
    if (request.operation === 'act' && !identity) {
      return {
        ok: false,
        error: 'State-bound desktop input requires explicit runId and agentId ownership.',
        code: 'SURFACE_TARGET_NOT_OWNED',
      };
    }
    let binding: ReturnType<SurfaceExecutionRuntime['getComputerBinding']> = null;
    try {
      binding = request.operation === 'act' && identity
        ? this.surfaceRuntime.getComputerBinding({
            identity,
            providerStateId: request.stateId,
          })
        : null;
    } catch (error) {
      if (error instanceof SurfaceExecutionRuntimeError) {
        return {
          ok: false,
          error: error.message,
          code: error.surfaceError.code,
          meta: { surfaceExecutionErrorV1: error.surfaceError },
        };
      }
      throw error;
    }
    if (request.operation === 'act' && !binding) {
      return {
        ok: false,
        error: 'Computer state is stale or owned by another Surface session.',
        code: 'SURFACE_STATE_STALE',
      };
    }
    if (request.operation === 'act' && typeof args.targetApp === 'string') {
      const app = this.stateApps.get(request.stateId);
      if (!app || app.expiresAtMs < Date.now()) {
        return { ok: false, code: 'INVALID_ARGS', error: 'App identity for stateId is unavailable; observe again with targetApp from list_roots.' };
      }
      if (args.targetApp.trim().toLowerCase() !== app.appName.trim().toLowerCase()) {
        return { ok: false, code: 'INVALID_ARGS', error: `Target app mismatch: state belongs to ${app.appName}; retry with targetApp set to that appName.` };
      }
    }
    if (request.operation === 'act') {
      const permit = await canUseTool(
        schema.name,
        {
          ...args,
          surfaceTarget: binding?.observation.target,
        },
        'State-bound desktop input',
        {
          sessionId: ctx.sessionId,
          type: 'dangerous_command',
          tool: schema.name,
          reason: 'State-bound desktop input',
          ...(gate?.forceConfirm
            ? { forceConfirm: true, details: { cuaJevRiskUpgrade: true } }
            : {}),
        },
      );
      if (!permit.allow) {
        return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
      }
    }
    if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };

    onProgress?.({ stage: 'running', detail: `computer_use ${request.operation}` });
    try {
      const operationId = ctx.currentToolCallId ?? `computer-use-${Date.now()}`;
      let execution: CuaStatefulExecutionResult;
      let surfaceMeta: Record<string, unknown> = {};
      if (request.operation === 'act' && identity && binding) {
        const unsubscribeLockLifecycle = subscribeCuaInputLockLifecycle((lifecycle) => {
          if (lifecycle.scope !== binding.subject.sessionId || lifecycle.phase === 'release') return;
          this.surfaceRuntime.recordComputerInputLockLifecycle({
            subject: binding.subject,
            lifecycle,
          });
        });
        let wrapped;
        try {
          wrapped = await this.surfaceRuntime.executeComputerAction({
            identity,
            providerStateId: request.stateId,
            operationId,
            arguments: args,
            ...(request.expect ? { expectation: request.expect } : {}),
            parentSignal: ctx.abortSignal,
            dispatch: async (signal, subject) => {
              const driverContext = {
                sessionId: ctx.sessionId,
                surfaceSessionId: subject.sessionId,
                runId: identity.runId,
                agentId: identity.agentId,
                toolCallId: operationId,
                abortSignal: signal,
              };
              const providerExecution = await this.adapter.execute(request, driverContext);
              if (providerExecution.response.operation !== 'act') {
                throw new Error('cua state adapter returned a non-action response');
              }
              const actionResult = providerExecution.response.result;
              let successorObservation;
              if (actionResult.successorState) {
                const ownership = this.adapter.getStateOwnership(
                  actionResult.successorState.stateId,
                  driverContext,
                );
                if (!ownership) {
                  throw new Error('cua successor state lost its Surface owner');
                }
                successorObservation = this.surfaceRuntime.recordComputerObservation({
                  identity,
                  surfaceSessionId: subject.sessionId,
                  state: actionResult.successorState,
                  metadata: {
                    providerGeneration: ownership.providerGeneration,
                    providerSnapshotId: ownership.providerSnapshotId,
                    evidenceAssetIds: [actionResult.evidenceRef],
                  },
                  userSummary: 'Observed the Computer target after input',
                }).observation;
              }
              return {
                providerResult: providerExecution,
                outcome: {
                  delivery: actionResult.delivery,
                  verification: actionResult.verification,
                  overall: actionResult.overall,
                  ...(successorObservation ? { successorObservation } : {}),
                  evidenceRefs: [actionResult.evidenceRef],
                  artifactRefs: [],
                  ...(actionResult.error
                    ? {
                        error: this.surfaceRuntime.surfaceErrorFromComputerResult({
                          identity,
                          operationId,
                          kind: actionResult.error.kind,
                          message: actionResult.error.message,
                          target: binding.observation.target,
                        }),
                      }
                    : {}),
                },
              };
            },
          });
        } finally {
          unsubscribeLockLifecycle();
        }
        execution = wrapped.providerResult;
        surfaceMeta = {
          surfaceSessionId: wrapped.session.sessionId,
          surfaceExecutionSessionV1: wrapped.session,
          surfaceExecutionActionResultV1: wrapped.surfaceResult,
          surfaceExecutionEventsV1: wrapped.events,
        };
      } else {
        const prepared = identity && request.operation === 'observe'
          ? this.surfaceRuntime.prepareComputerSession({ identity })
          : null;
        const driverContext = {
          sessionId: ctx.sessionId,
          ...(prepared ? { surfaceSessionId: prepared.session.sessionId } : {}),
          ...(identity ? { runId: identity.runId, agentId: identity.agentId } : {}),
          toolCallId: operationId,
          abortSignal: ctx.abortSignal,
        };
        if (request.operation === 'observe' && typeof args.targetApp === 'string') {
          const listed = await this.adapter.execute({ operation: 'list_roots' }, driverContext);
          const root = listed.response.operation === 'list_roots'
            ? listed.response.roots.find((item) => item.pid === request.target.pid && item.windowId === request.target.windowId)
            : undefined;
          if (!root?.appName?.trim()) {
            return { ok: false, code: 'INVALID_ARGS', error: 'Target has no app identity; list_roots and select a current window.' };
          }
          if (args.targetApp.trim().toLowerCase() !== root.appName.trim().toLowerCase()) {
            return { ok: false, code: 'INVALID_ARGS', error: `Target app mismatch: window belongs to ${root.appName}; retry with targetApp set to that appName.` };
          }
        }
        if (prepared) {
          await this.adapter.startSurfaceSession(driverContext);
          const cleanupContext = {
            sessionId: driverContext.sessionId,
            surfaceSessionId: driverContext.surfaceSessionId,
            runId: driverContext.runId,
            agentId: driverContext.agentId,
            toolCallId: `${operationId}:cleanup`,
          };
          this.surfaceRuntime.registerCleanup(
            prepared.subject,
            () => this.adapter.endSurfaceSession(cleanupContext),
          );
        }
        execution = await this.adapter.execute(request, driverContext);
        if (identity && prepared && execution.response.operation === 'observe') {
          const ownership = this.adapter.getStateOwnership(
            execution.response.state.stateId,
            driverContext,
          );
          if (!ownership) throw new Error('cua observation lost its Surface owner');
          const recorded = this.surfaceRuntime.recordComputerObservation({
            identity,
            surfaceSessionId: prepared.session.sessionId,
            state: execution.response.state,
            metadata: {
              providerGeneration: ownership.providerGeneration,
              providerSnapshotId: ownership.providerSnapshotId,
            },
          });
          surfaceMeta = {
            surfaceSessionId: recorded.session.sessionId,
            surfaceExecutionSessionV1: recorded.session,
            surfaceObservationV1: recorded.observation,
            surfaceExecutionEventsV1: recorded.events,
          };
        }
      }
      onProgress?.({ stage: 'completing', percent: 100 });
      const response = execution.response;
      const state = response.operation === 'observe' ? response.state
        : response.operation === 'act' ? response.result.successorState : undefined;
      for (const [stateId, app] of this.stateApps) {
        if (app.expiresAtMs < Date.now()) this.stateApps.delete(stateId);
      }
      if (state?.root.appName) {
        this.stateApps.set(state.stateId, { appName: state.root.appName, expiresAtMs: state.expiresAtMs });
      }
      const output = JSON.stringify(response);
      const meta = {
        ...resultMeta(execution),
        ...surfaceMeta,
      };
      const actionFailed = response.operation === 'act'
        && (response.result.overall === 'failed' || response.result.overall === 'ambiguous');
      const proofed = identity && typeof meta.surfaceSessionId === 'string'
        ? surfaceProofService.finalizeToolResult({
            toolName: 'computer_use',
            action: request.operation,
            surface: 'computer',
            result: {
              success: !actionFailed,
              ...(actionFailed ? { error: output } : { output }),
              metadata: meta,
            },
            identity: {
              conversationId: identity.conversationId,
              runId: identity.runId,
              turnId: identity.turnId,
              agentId: identity.agentId,
              surfaceSessionId: meta.surfaceSessionId,
              operationId,
            },
          })
        : null;
      const proofMeta = proofed?.metadata || meta;
      if (actionFailed) {
        return {
          ok: false,
          error: output,
          code: response.result.overall === 'ambiguous'
            ? 'CUA_ACTION_AMBIGUOUS'
            : 'CUA_ACTION_FAILED',
          meta: proofMeta,
        };
      }
      return { ok: true, output, meta: proofMeta };
    } catch (error) {
      if (error instanceof SurfaceExecutionRuntimeError) {
        return {
          ok: false,
          error: error.message,
          code: error.surfaceError.code,
          meta: { surfaceExecutionErrorV1: error.surfaceError },
        };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'CUA_STATE_ERROR',
      };
    }
  }
}

/**
 * N-JEV-CU-STEP-LOOP：armed=true 时 schema 才带 execute_goal（operation 枚举 +
 * task/jevBudgetUsd + 描述后缀）；false 时与既有静态 schema 逐字节一致。
 * armed 的判定（V2 + CODE_AGENT_CUA_JEV_STEP=1 + typesafe key）在插件装配点做。
 */
export function cuaStatefulComputerUseModuleFor(
  jevStepArmed: boolean,
): ToolModule<Record<string, unknown>, string> {
  return {
    schema: jevStepArmed ? withCuaJevStepOperation(schema) : schema,
    createHandler() {
      return new CuaStatefulComputerUseHandler();
    },
  };
}
