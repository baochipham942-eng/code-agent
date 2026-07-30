import type { ToolHandler, ToolModule, ToolResult } from '../../../protocol/tools';
import { getSpaceOperationsService, type SpaceOperations } from '../../../services/project/spaceOperationsService';
import { spaceQuerySchema as schema } from './spaceQuery.schema';

export async function executeSpaceQuery(
  args: Record<string, unknown>,
  _ctx: Parameters<ToolHandler['execute']>[1],
  _canUseTool: Parameters<ToolHandler['execute']>[2],
  _onProgress?: Parameters<ToolHandler['execute']>[3],
  operations: SpaceOperations = getSpaceOperationsService(),
): Promise<ToolResult<string>> {
  if (typeof args.projectId !== 'string' || !args.projectId.trim()) {
    return { ok: false, error: 'projectId is required', code: 'INVALID_ARGS' };
  }
  const result = await operations.query(args.projectId);
  if (!result) {
    return { ok: false, error: 'Collaboration space not found', code: 'NOT_FOUND' };
  }
  return {
    ok: true,
    output: JSON.stringify(result, null, 2),
    meta: { result },
  };
}

class SpaceQueryHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(...args: Parameters<ToolHandler<Record<string, unknown>, string>['execute']>) {
    return executeSpaceQuery(...args);
  }
}

export const spaceQueryModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new SpaceQueryHandler(),
};
