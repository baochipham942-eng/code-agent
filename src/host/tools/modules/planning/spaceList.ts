import type { ToolHandler, ToolModule, ToolResult } from '../../../protocol/tools';
import { getSpaceOperationsService, type SpaceOperations } from '../../../services/project/spaceOperationsService';
import { spaceListSchema as schema } from './spaceList.schema';

export async function executeSpaceList(
  _args: Record<string, unknown>,
  _ctx: Parameters<ToolHandler['execute']>[1],
  _canUseTool: Parameters<ToolHandler['execute']>[2],
  _onProgress?: Parameters<ToolHandler['execute']>[3],
  operations: SpaceOperations = getSpaceOperationsService(),
): Promise<ToolResult<string>> {
  const spaces = operations.list();
  return {
    ok: true,
    output: JSON.stringify({ spaces }, null, 2),
    meta: { spaces },
  };
}

class SpaceListHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(...args: Parameters<ToolHandler<Record<string, unknown>, string>['execute']>) {
    return executeSpaceList(...args);
  }
}

export const spaceListModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new SpaceListHandler(),
};
