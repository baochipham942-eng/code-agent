import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { createFailedReceiptArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { executeTmeetCommand } from './tmeetToolCli';
import { tmeetMeetingListSchema as schema } from './tmeetMeetingList.schema';

function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('tmeet meeting list returned invalid JSON', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tmeet meeting list returned an invalid response');
  }
  return value as Record<string, unknown>;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

async function executeTmeetMeetingList(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  let commandArgs: string[];
  try {
    commandArgs = ['meeting', 'list'];
    const start = optionalString(args, 'start');
    const end = optionalString(args, 'end');
    const pageToken = optionalString(args, 'page_token');
    if (start) commandArgs.push('--start', start);
    if (end) commandArgs.push('--end', end);
    if (args.show_all_sub !== undefined) {
      if (args.show_all_sub !== 0 && args.show_all_sub !== 1) {
        return { ok: false, error: 'show_all_sub must be 0 or 1', code: 'INVALID_ARGS' };
      }
      commandArgs.push('--show-all-sub', String(args.show_all_sub));
    }
    if (pageToken) commandArgs.push('--page-token', pageToken);
    if (args.page_size !== undefined) {
      if (!Number.isInteger(args.page_size) || Number(args.page_size) < 1 || Number(args.page_size) > 20) {
        return { ok: false, error: 'page_size must be an integer from 1 to 20', code: 'INVALID_ARGS' };
      }
      commandArgs.push('--page-size', String(args.page_size));
    }
    if (args.compact !== false) commandArgs.push('--compact');
    commandArgs.push('--format', 'json');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };
  onProgress?.({ stage: 'starting', detail: schema.name });

  try {
    const output = await executeTmeetCommand(commandArgs, 'tmeet meeting list');
    const response = parseJsonObject(output);
    return {
      ok: true,
      output,
      meta: {
        action: 'meeting.list',
        connector: 'tmeet',
        response,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: 'Tencent Meeting list receipt',
          mimeType: 'application/json',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: { connector: 'tmeet', action: 'meeting.list' },
        }),
      },
    };
  } catch (error) {
    const failure = `Tencent Meeting list failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      error: failure,
      meta: {
        action: 'meeting.list',
        connector: 'tmeet',
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action: 'meeting.list',
          name: 'Tencent Meeting list failed',
          error: failure,
          metadata: { connector: 'tmeet' },
        }),
      },
    };
  }
}

class TmeetMeetingListHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTmeetMeetingList(args, ctx, canUseTool, onProgress);
  }
}

export const tmeetMeetingListModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TmeetMeetingListHandler();
  },
};
