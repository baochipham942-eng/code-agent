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
import { tmeetMeetingSearchSchema as schema } from './tmeetMeetingSearch.schema';

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('tmeet meeting search returned invalid JSON', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tmeet meeting search returned an invalid response');
  }
  return value as Record<string, unknown>;
}

function buildSearchArguments(args: Record<string, unknown>): string[] {
  const commandArgs = ['meeting', 'search'];
  const query = optionalString(args, 'query');
  const queryField = optionalString(args, 'query_field');
  const meetingCode = optionalString(args, 'meeting_code');
  const start = optionalString(args, 'start');
  const end = optionalString(args, 'end');
  const pageToken = optionalString(args, 'page_token');

  if (query) commandArgs.push('--query', query);
  if (queryField) {
    if (!['subject', 'creator', 'note', 'all'].includes(queryField)) {
      throw new Error('query_field must be subject, creator, note, or all');
    }
    commandArgs.push('--query-field', queryField);
  }
  if (meetingCode) {
    if (!/^\d+$/.test(meetingCode)) throw new Error('meeting_code must contain digits only');
    commandArgs.push('--meeting-code', meetingCode);
  }
  if (start) commandArgs.push('--start', start);
  if (end) commandArgs.push('--end', end);
  if (pageToken) commandArgs.push('--page-token', pageToken);
  if (args.page_size !== undefined) {
    if (!Number.isInteger(args.page_size) || Number(args.page_size) < 1 || Number(args.page_size) > 30) {
      throw new Error('page_size must be an integer from 1 to 30');
    }
    commandArgs.push('--page-size', String(args.page_size));
  }
  if (args.compact !== false) commandArgs.push('--compact');
  commandArgs.push('--format', 'json');
  return commandArgs;
}

async function executeTmeetMeetingSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  let commandArgs: string[];
  try {
    commandArgs = buildSearchArguments(args);
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
    const output = await executeTmeetCommand(commandArgs, 'tmeet meeting search');
    const response = parseJsonObject(output);
    const receipt = formatTmeetMeetingReceipt(response, '没有找到匹配的会议');
    return {
      ok: true,
      output,
      meta: {
        action: 'meeting.search',
        connector: 'tmeet',
        response,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: '腾讯会议搜索结果',
          mimeType: 'text/markdown',
          contentLength: receipt.length,
          preview: receipt,
          metadata: { connector: 'tmeet', action: 'meeting.search' },
        }),
      },
    };
  } catch (error) {
    const failure = `Tencent Meeting search failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      error: failure,
      meta: {
        action: 'meeting.search',
        connector: 'tmeet',
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action: 'meeting.search',
          name: '搜索腾讯会议失败',
          error: failure,
          metadata: { connector: 'tmeet' },
        }),
      },
    };
  }
}

class TmeetMeetingSearchHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTmeetMeetingSearch(args, ctx, canUseTool, onProgress);
  }
}

export const tmeetMeetingSearchModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TmeetMeetingSearchHandler();
  },
};
