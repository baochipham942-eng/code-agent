import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { wakeNoopSchema as schema } from './wakeNoop.schema';

export async function executeWakeNoop(
  _args: Record<string, unknown>,
  _ctx: ToolContext,
  _canUseTool: CanUseToolFn,
  _onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  return { ok: true, output: '' };
}

class WakeNoopHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeWakeNoop(args, ctx, canUseTool, onProgress);
  }
}

export const wakeNoopModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new WakeNoopHandler();
  },
};
