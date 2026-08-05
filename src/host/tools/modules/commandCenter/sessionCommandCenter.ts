import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { MessageAttachment } from '../../../../shared/contract';
import { getSessionCommandCenter, type SessionTaskReferenceResult } from '../../../services/commandCenter/sessionCommandCenter';
import {
  cancelTaskSchema,
  spawnTaskSchema,
  steerTaskSchema,
  taskStatusSchema,
} from './sessionCommandCenter.schema';

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? args[key].trim() : '';
}

function requireSession(ctx: ToolContext): ToolResult<string> | string {
  return ctx.sessionId?.trim() || { ok: false, error: 'No active session', code: 'DOMAIN_ERROR' };
}

function describeReferenceFailure(result: SessionTaskReferenceResult, action: string): string {
  if (result.outcome === 'missing') return `没有找到可${action}的活跃任务，什么都没改。先调用 task_status 核对。`;
  if (result.outcome === 'ambiguous') {
    const options = result.candidates.map((task) => task.shortName).join('、');
    return `目标不唯一，什么都没改。现在调用 AskUserQuestion 让用户从这些短名中选择：${options}。`;
  }
  return '';
}

async function permit(
  schemaName: string,
  args: Record<string, unknown>,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string> | null> {
  const decision = await canUseTool(schemaName, args);
  return decision.allow
    ? null
    : { ok: false, error: `permission denied: ${decision.reason}`, code: 'PERMISSION_DENIED' };
}

export async function executeSpawnTask(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const denied = await permit(spawnTaskSchema.name, args, canUseTool);
  if (denied) return denied;
  const session = requireSession(ctx);
  if (typeof session !== 'string') return session;
  const title = stringArg(args, 'title');
  const shortName = stringArg(args, 'short_name');
  const laneKey = stringArg(args, 'lane_key');
  const submissionKey = stringArg(args, 'submission_key');
  const prompt = stringArg(args, 'prompt');
  if (!title || !shortName || !laneKey || !submissionKey || !prompt) {
    return { ok: false, error: 'title, short_name, lane_key, submission_key and prompt are required', code: 'INVALID_ARGS' };
  }
  const shortNameLength = Array.from(shortName).length;
  if (shortNameLength < 2 || shortNameLength > 4) {
    return { ok: false, error: 'short_name must contain 2-4 characters', code: 'INVALID_ARGS' };
  }
  if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };

  onProgress?.({ stage: 'starting', detail: shortName });
  const result = await getSessionCommandCenter().spawn({
    sessionId: session,
    title,
    shortName,
    laneKey,
    submissionKey,
    prompt,
    queueWhenFull: args.queue_when_full === true,
    attachments: ctx.subagent?.attachments as MessageAttachment[] | undefined,
    options: {
      mode: 'normal',
      toolScope: ctx.toolScope,
      executionIntent: ctx.executionIntent,
    },
  });
  onProgress?.({ stage: 'completing', percent: 100 });
  if (result.outcome === 'requires_choice') {
    const options = result.active.map((task) => task.shortName).join('、');
    return {
      ok: true,
      output: `并发槽已满，任务尚未创建。现在调用 AskUserQuestion，让用户选择“排队”或替换这些活跃任务之一：${options}。`,
    };
  }
  if (result.outcome === 'reused') {
    return { ok: true, output: `reused：复用「${result.task.shortName}」(${result.task.id})，没有重复派发。` };
  }
  if (result.outcome === 'queued') {
    return { ok: true, output: `queued：已把「${result.task.shortName}」(${result.task.id}) 放进同一任务线，前序任务结束后自动开始。` };
  }
  return {
    ok: true,
    output: `accepted：后台任务「${result.task.shortName}」(${result.task.id}) 已开始。accepted 不等于完成；结果只以后续任务终态回流为准。`,
  };
}

export async function executeSteerTask(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const denied = await permit(steerTaskSchema.name, args, canUseTool);
  if (denied) return denied;
  const session = requireSession(ctx);
  if (typeof session !== 'string') return session;
  const instruction = stringArg(args, 'instruction');
  if (!instruction) return { ok: false, error: 'instruction is required', code: 'INVALID_ARGS' };
  const result = await getSessionCommandCenter().steer(session, stringArg(args, 'target') || undefined, instruction);
  if (result.outcome !== 'resolved') return { ok: true, output: describeReferenceFailure(result, '转向') };
  return { ok: true, output: `已把新要求投递给「${result.task.shortName}」；它的完成状态仍以后续终态回流为准。` };
}

export async function executeCancelTask(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const denied = await permit(cancelTaskSchema.name, args, canUseTool);
  if (denied) return denied;
  const session = requireSession(ctx);
  if (typeof session !== 'string') return session;
  const result = await getSessionCommandCenter().cancel(session, stringArg(args, 'target') || undefined);
  if (result.outcome !== 'resolved') return { ok: true, output: describeReferenceFailure(result, '取消') };
  const verb = result.task.status === 'cancelled' ? '已取消' : '正在取消';
  return { ok: true, output: `${verb}「${result.task.shortName}」；只有终态回流后才能声称它已经停稳。` };
}

export async function executeTaskStatus(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const denied = await permit(taskStatusSchema.name, args, canUseTool);
  if (denied) return denied;
  const session = requireSession(ctx);
  if (typeof session !== 'string') return session;
  const tasks = getSessionCommandCenter().list(session);
  if (tasks.length === 0) return { ok: true, output: '当前会话还没有后台任务。' };
  return {
    ok: true,
    output: tasks.map((task, index) => (
      `${index + 1}. ${task.shortName} [${task.status}] id=${task.id}${task.summary ? `：${task.summary}` : ''}`
    )).join('\n'),
  };
}

type CommandToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
) => Promise<ToolResult<string>>;

class Handler implements ToolHandler<Record<string, unknown>, string> {
  constructor(
    readonly schema: typeof spawnTaskSchema,
    private readonly executeFn: CommandToolExecutor,
  ) {}

  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return this.executeFn(args, ctx, canUseTool, onProgress);
  }
}

function moduleFor(
  schema: typeof spawnTaskSchema,
  executeFn: CommandToolExecutor,
): ToolModule<Record<string, unknown>, string> {
  return { schema, createHandler: () => new Handler(schema, executeFn) };
}

export const spawnTaskModule = moduleFor(spawnTaskSchema, executeSpawnTask);
export const steerTaskModule = moduleFor(steerTaskSchema, executeSteerTask);
export const cancelTaskModule = moduleFor(cancelTaskSchema, executeCancelTask);
export const taskStatusModule = moduleFor(taskStatusSchema, executeTaskStatus);
