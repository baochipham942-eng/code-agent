import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { createFailedReceiptArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { formatTmeetMeetingReceipt } from './tmeetMeetingReceipt';
import { executeTmeetCommand } from './tmeetToolCli';
import { tmeetMeetingListSchema as schema } from './tmeetMeetingList.schema';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

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
  let scope: 'upcoming' | 'ended';
  let action: 'meeting.list' | 'meeting.list-ended';
  let effectiveStart: string | undefined;
  try {
    if (args.scope !== undefined && args.scope !== 'upcoming' && args.scope !== 'ended') {
      throw new Error('scope must be upcoming or ended');
    }
    scope = args.scope === 'ended' ? 'ended' : 'upcoming';
    action = scope === 'ended' ? 'meeting.list-ended' : 'meeting.list';
    commandArgs = ['meeting', scope === 'ended' ? 'list-ended' : 'list'];
    const start = optionalString(args, 'start');
    effectiveStart = start ?? (scope === 'ended' ? new Date(Date.now() - THIRTY_DAYS_MS).toISOString() : undefined);
    const end = optionalString(args, 'end');
    const pageToken = optionalString(args, 'page_token');
    if (effectiveStart) commandArgs.push('--start', effectiveStart);
    if (end) commandArgs.push('--end', end);
    if (args.show_all_sub !== undefined) {
      if (scope === 'ended') throw new Error('show_all_sub is only supported for upcoming meetings');
      if (args.show_all_sub !== 0 && args.show_all_sub !== 1) {
        return { ok: false, error: 'show_all_sub must be 0 or 1', code: 'INVALID_ARGS' };
      }
      commandArgs.push('--show-all-sub', String(args.show_all_sub));
    }
    if (pageToken) commandArgs.push('--page-token', pageToken);
    if (args.page_size !== undefined) {
      const maximum = scope === 'ended' ? 30 : 20;
      if (!Number.isInteger(args.page_size) || Number(args.page_size) < 1 || Number(args.page_size) > maximum) {
        return { ok: false, error: `page_size must be an integer from 1 to ${maximum}`, code: 'INVALID_ARGS' };
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
    const commandLabel = scope === 'ended' ? 'tmeet meeting list-ended' : 'tmeet meeting list';
    const output = await executeTmeetCommand(commandArgs, commandLabel);
    const response = parseJsonObject(output);
    const receipt = formatTmeetMeetingReceipt(
      response,
      scope === 'ended' ? '近 30 天没有已结束的会议' : '没有待开始/进行中的会议',
    );
    return {
      ok: true,
      output,
      meta: {
        action,
        connector: 'tmeet',
        scope,
        effectiveStart,
        response,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: scope === 'ended' ? '已结束的腾讯会议' : '待开始/进行中的腾讯会议',
          mimeType: 'text/markdown',
          contentLength: receipt.length,
          preview: receipt,
          metadata: { connector: 'tmeet', action, scope, effectiveStart },
        }),
      },
    };
  } catch (error) {
    const failure = `Tencent Meeting ${scope === 'ended' ? 'list-ended' : 'list'} failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      error: failure,
      meta: {
        action,
        connector: 'tmeet',
        scope,
        effectiveStart,
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action,
          name: scope === 'ended' ? '查询已结束的腾讯会议失败' : '查询待开始/进行中的腾讯会议失败',
          error: failure,
          metadata: { connector: 'tmeet', scope, effectiveStart },
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
