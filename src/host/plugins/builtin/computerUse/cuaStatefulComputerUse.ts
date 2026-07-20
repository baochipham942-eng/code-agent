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
import { cuaStatefulComputerUseSchema as schema } from './cuaStatefulComputerUse.schema';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRequest(args: Record<string, unknown>): CuaStatefulComputerUseRequest {
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
  throw new Error('operation must be list_roots, observe, or act');
}

function runtimeIdentity(ctx: ToolContext): SurfaceRuntimeIdentityV1 | null {
  const runId = ctx.runId?.trim();
  const agentId = ctx.agentId?.trim();
  if (!runId || !agentId) return null;
  return {
    conversationId: ctx.sessionId,
    runId,
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

  constructor(
    private readonly adapter = new CuaStateAdapter(new CuaMcpDriverPort()),
    private readonly surfaceRuntime: SurfaceExecutionRuntime = getSurfaceExecutionRuntime(),
  ) {}

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    let request: CuaStatefulComputerUseRequest;
    try {
      request = parseRequest(args);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'INVALID_ARGS',
      };
    }
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
        const wrapped = await this.surfaceRuntime.executeComputerAction({
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
      const output = JSON.stringify(response);
      const meta = {
        ...resultMeta(execution),
        ...surfaceMeta,
      };
      if (
        response.operation === 'act'
        && (response.result.overall === 'failed' || response.result.overall === 'ambiguous')
      ) {
        return {
          ok: false,
          error: output,
          code: response.result.overall === 'ambiguous'
            ? 'CUA_ACTION_AMBIGUOUS'
            : 'CUA_ACTION_FAILED',
          meta,
        };
      }
      return { ok: true, output, meta };
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

export const cuaStatefulComputerUseModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new CuaStatefulComputerUseHandler();
  },
};
