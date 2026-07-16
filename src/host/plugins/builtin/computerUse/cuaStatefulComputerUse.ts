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
} from '../../../mcp/cuaStateAdapter';
import { CuaMcpDriverPort } from '../../../mcp/cuaMcpDriverPort';
import { cuaStatefulComputerUseSchema as schema } from './cuaStatefulComputerUse.schema';
import type {
  ComputerUseExpectationV1,
  ComputerUseMutationV1,
} from '../../../../shared/contract/desktop';

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

class CuaStatefulComputerUseHandler
implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  constructor(private readonly adapter = new CuaStateAdapter(new CuaMcpDriverPort())) {}

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
    if (request.operation === 'act') {
      const permit = await canUseTool(
        schema.name,
        args,
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
      const execution = await this.adapter.execute(request, {
        sessionId: ctx.sessionId,
        toolCallId: ctx.currentToolCallId ?? `computer-use-${Date.now()}`,
        abortSignal: ctx.abortSignal,
      });
      onProgress?.({ stage: 'completing', percent: 100 });
      const response = execution.response;
      const state = response.operation === 'observe'
        ? response.state
        : response.operation === 'act'
          ? response.result.successorState
          : undefined;
      const output = JSON.stringify(response);
      const meta = {
        computerUseStateV1: state,
        ...(response.operation === 'act' ? { computerUseActionResultV1: response.result } : {}),
        ...(execution.imageDataUrl ? { imageBase64: execution.imageDataUrl } : {}),
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
