import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getSpaceOperationsService, type SpaceOperations } from '../../../services/project/spaceOperationsService';
import { spaceCreateSchema as schema } from './spaceCreate.schema';

export async function executeSpaceCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
  operations: SpaceOperations = getSpaceOperationsService(),
): Promise<ToolResult<string>> {
  if (typeof args.name !== 'string' || !args.name.trim()) {
    return { ok: false, error: 'name is required', code: 'INVALID_ARGS' };
  }
  if (args.workspacePath !== undefined && (
    typeof args.workspacePath !== 'string' || !args.workspacePath.trim()
  )) {
    return { ok: false, error: 'workspacePath must be a non-empty string', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(
    schema.name,
    args,
    `Create collaboration space "${args.name.trim()}"`,
    {
      sessionId: ctx.sessionId,
      forceConfirm: true,
      type: args.workspacePath ? 'directory_access' : 'file_write',
      tool: schema.name,
      reason: 'Creating a collaboration space changes durable project state.',
      dangerLevel: 'normal',
    },
  );
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });
  try {
    const space = await operations.create({
      name: args.name.trim(),
      description: typeof args.description === 'string' ? args.description.trim() || undefined : undefined,
      workspacePath: typeof args.workspacePath === 'string' ? args.workspacePath.trim() : undefined,
      trustAcknowledged: args.trustAcknowledged === true,
    });
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: JSON.stringify({ space }, null, 2),
      meta: { space },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'SPACE_CREATE_FAILED',
    };
  }
}

class SpaceCreateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ) {
    return executeSpaceCreate(args, ctx, canUseTool, onProgress);
  }
}

export const spaceCreateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new SpaceCreateHandler(),
};
