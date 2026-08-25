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
import { tmeetMeetingCreateSchema as schema } from './tmeetMeetingCreate.schema';

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function appendString(args: Record<string, unknown>, key: string, flag: string, target: string[]): void {
  const value = args[key];
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  target.push(flag, value);
}

function appendInteger(
  args: Record<string, unknown>,
  key: string,
  flag: string,
  target: string[],
  range?: { min: number; max: number },
): void {
  const value = args[key];
  if (value === undefined) return;
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  if (range && (Number(value) < range.min || Number(value) > range.max)) {
    throw new Error(`${key} must be from ${range.min} to ${range.max}`);
  }
  target.push(flag, String(value));
}

function buildCreateArguments(args: Record<string, unknown>): string[] {
  const commandArgs = [
    'meeting', 'create',
    '--subject', requiredString(args, 'subject'),
    '--start', requiredString(args, 'start'),
    '--end', requiredString(args, 'end'),
  ];
  appendString(args, 'password', '--password', commandArgs);
  appendString(args, 'timezone', '--timezone', commandArgs);
  appendInteger(args, 'meeting_type', '--meeting-type', commandArgs, { min: 0, max: 1 });
  appendInteger(args, 'join_type', '--join-type', commandArgs, { min: 1, max: 3 });
  if (args.waiting_room === true) commandArgs.push('--waiting-room');
  if (args.waiting_room !== undefined && typeof args.waiting_room !== 'boolean') {
    throw new Error('waiting_room must be a boolean');
  }
  appendInteger(args, 'recurring_type', '--recurring-type', commandArgs, { min: 0, max: 4 });
  appendInteger(args, 'until_type', '--until-type', commandArgs, { min: 0, max: 1 });
  appendInteger(args, 'until_count', '--until-count', commandArgs, { min: 1, max: 500 });
  appendString(args, 'until_date', '--until-date', commandArgs);
  if (args.invitees !== undefined) {
    if (!Array.isArray(args.invitees)
      || args.invitees.length > 100
      || args.invitees.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error('invitees must be an array of at most 100 non-empty strings');
    }
    if (args.invitees.length > 0) commandArgs.push('--invitees', args.invitees.join(','));
  }
  appendInteger(args, 'water_mark_type', '--water-mark-type', commandArgs, { min: 0, max: 2 });
  if (args.audio_watermark !== undefined) {
    if (typeof args.audio_watermark !== 'boolean') throw new Error('audio_watermark must be a boolean');
    commandArgs.push(`--audio-watermark=${args.audio_watermark}`);
  }
  appendString(args, 'auto_record_type', '--auto-record-type', commandArgs);
  if (args.auto_asr !== undefined) {
    if (typeof args.auto_asr !== 'boolean') throw new Error('auto_asr must be a boolean');
    commandArgs.push(`--auto-asr=${args.auto_asr}`);
  }
  commandArgs.push('--format', 'json');
  return commandArgs;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('tmeet meeting create returned invalid JSON', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tmeet meeting create returned an invalid response');
  }
  return value as Record<string, unknown>;
}

async function executeTmeetMeetingCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  let commandArgs: string[];
  try {
    commandArgs = buildCreateArguments(args);
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
    const output = await executeTmeetCommand(commandArgs, 'tmeet meeting create');
    const response = parseJsonObject(output);
    const subject = String(args.subject);
    return {
      ok: true,
      output,
      meta: {
        action: 'meeting.create',
        connector: 'tmeet',
        subject,
        response,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: `Tencent Meeting created: ${subject}`,
          mimeType: 'application/json',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: { connector: 'tmeet', action: 'meeting.create', subject },
        }),
      },
    };
  } catch (error) {
    const failure = `Tencent Meeting create failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      error: failure,
      meta: {
        action: 'meeting.create',
        connector: 'tmeet',
        subject: args.subject,
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action: 'meeting.create',
          name: `Tencent Meeting create failed: ${String(args.subject)}`,
          error: failure,
          metadata: { connector: 'tmeet', subject: args.subject },
        }),
      },
    };
  }
}

class TmeetMeetingCreateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTmeetMeetingCreate(args, ctx, canUseTool, onProgress);
  }
}

export const tmeetMeetingCreateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TmeetMeetingCreateHandler();
  },
};
