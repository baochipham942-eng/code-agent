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
import { resolveBackgroundWorkspaceAuthority } from '../../../task/backgroundWorkspaceAuthority';
import {
  cancelTaskSchema,
  delegateTaskSchema,
  steerTaskSchema,
  taskStatusSchema,
} from './sessionCommandCenter.schema';

const WORKSPACE_REQUIRED_MESSAGE = '没有可写的项目根，请先选择项目或添加目录。';

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? args[key].trim() : '';
}

/** Keep the UI/reference key compact even when a provider emits an English phrase. */
export function normalizeSessionTaskShortName(value: string, title: string): string {
  const compact = value.replace(/\s+/g, '').trim();
  const chars = Array.from(compact);
  if (chars.length >= 2 && chars.length <= 4) return compact;

  if (chars.length > 4) {
    const words = compact.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g);
    if (words && words.length >= 2) {
      const initials = words.map((word) => Array.from(word)[0]).join('').toUpperCase();
      if (Array.from(initials).length >= 2 && Array.from(initials).length <= 4) return initials;
    }
    return chars.slice(0, 4).join('');
  }

  const titleChars = Array.from(title.replace(/\s+/g, '').trim());
  const fallback = [...chars, ...titleChars, ...Array.from('任务')].slice(0, 4).join('');
  return Array.from(fallback).length >= 2 ? fallback : '任务';
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

export async function executeDelegateTask(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const denied = await permit(delegateTaskSchema.name, args, canUseTool);
  if (denied) return denied;
  const session = requireSession(ctx);
  if (typeof session !== 'string') return session;
  const title = stringArg(args, 'title');
  const rawShortName = stringArg(args, 'short_name');
  const laneKey = stringArg(args, 'lane_key');
  const submissionKey = stringArg(args, 'submission_key');
  const prompt = stringArg(args, 'prompt');
  if (!title || !rawShortName || !laneKey || !submissionKey || !prompt) {
    return { ok: false, error: 'title, short_name, lane_key, submission_key and prompt are required', code: 'INVALID_ARGS' };
  }
  const shortName = normalizeSessionTaskShortName(rawShortName, title);
  if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };
  const workspaceScope = resolveBackgroundWorkspaceAuthority({
    workspace: ctx.workspace,
    workspaceScope: ctx.workspaceScope,
  });
  if (!workspaceScope) {
    return {
      ok: false,
      error: WORKSPACE_REQUIRED_MESSAGE,
      code: 'WORKSPACE_REQUIRED',
    };
  }

  onProgress?.({ stage: 'starting', detail: shortName });
  const result = await getSessionCommandCenter().spawn({
    sessionId: session,
    title,
    shortName,
    laneKey,
    submissionKey,
    prompt,
    workspaceScope,
    queueWhenFull: args.queue_when_full === true,
    attachments: ctx.subagent?.attachments as MessageAttachment[] | undefined,
    options: {
      mode: 'normal',
      toolScope: ctx.toolScope,
      executionIntent: ctx.executionIntent,
    },
    parentRunId: ctx.runId,
    parentTurnId: ctx.turnId,
    toolCallId: ctx.currentToolCallId,
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
    readonly schema: typeof delegateTaskSchema,
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
  schema: typeof delegateTaskSchema,
  executeFn: CommandToolExecutor,
): ToolModule<Record<string, unknown>, string> {
  return { schema, createHandler: () => new Handler(schema, executeFn) };
}

export const delegateTaskModule = moduleFor(delegateTaskSchema, executeDelegateTask);
export const steerTaskModule = moduleFor(steerTaskSchema, executeSteerTask);
export const cancelTaskModule = moduleFor(cancelTaskSchema, executeCancelTask);
export const taskStatusModule = moduleFor(taskStatusSchema, executeTaskStatus);
