// ============================================================================
// sleep_until / wake_on / wake_on_event — agent 自发挂起-续跑
// ============================================================================
// Neo 原有的 role-wake 是「外部按时把某个角色叫醒」；这里补上另一半：agent 在本轮里
// 主动把自己停下，等条件满足再续跑。挂起后本轮直接结束，等待期零 idle 成本——
// 长等待任务不再靠「反复轮询 + 占着一轮不放」硬扛。
//
// 台账在 SQLite（重启后 pending 的醒来照样触发），配额按会话累计（防重试风暴）。
// ============================================================================

import { AGENT_WAKE } from '../../../../shared/constants/agent';
import type { AgentWakeKind } from '../../../../shared/contract/agentWake';
import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { getWakeService, type ParkWakeInput } from '../../../services/wake/wakeService';
import { sleepUntilSchema, wakeOnEventSchema, wakeOnSchema } from './selfWake.schema';

function readReason(args: Record<string, unknown>): string {
  return typeof args.reason === 'string' ? args.reason.trim() : '';
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** 三个工具的公共壳：校验 → 审批 → 配额内挂起 → 把「什么时候会醒」说清楚。 */
async function park(
  schema: ToolSchema,
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  build: (reason: string) => { input: Omit<ParkWakeInput, 'sessionId'>; confirmation: string } | { error: string },
): Promise<ToolResult<string>> {
  const reason = readReason(args);
  if (!reason) {
    return { ok: false, error: 'reason is required: say what you will do when you wake up', code: 'INVALID_ARGS' };
  }

  const built = build(reason);
  if ('error' in built) {
    return { ok: false, error: built.error, code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };

  const result = getWakeService().park({ ...built.input, sessionId: ctx.sessionId });
  if (!result.ok) {
    return {
      ok: false,
      error:
        `This session has already parked ${result.used} wake-ups (limit ${result.limit}). `
        + 'Do not park again — finish what you can now, or tell the user what is blocking you.',
      code: 'QUOTA_EXCEEDED',
    };
  }

  ctx.logger.info('self-wake parked', { id: result.record.id, kind: result.record.kind });
  return {
    ok: true,
    output: built.confirmation,
    meta: { wakeId: result.record.id, kind: result.record.kind, dueAt: result.record.dueAt },
  };
}

function handlerFor(
  schema: ToolSchema,
  build: (reason: string, args: Record<string, unknown>) => { input: Omit<ParkWakeInput, 'sessionId'>; confirmation: string } | { error: string },
): ToolHandler<Record<string, unknown>, string> {
  return {
    schema,
    execute: (args, ctx, canUseTool) => park(schema, args, ctx, canUseTool, (reason) => build(reason, args)),
  };
}

function timeWake(reason: string, args: Record<string, unknown>) {
  const raw = readString(args, 'until');
  const dueAt = Date.parse(raw);
  if (!raw || Number.isNaN(dueAt)) {
    return { error: `until must be an ISO 8601 timestamp, got "${raw}"` };
  }
  // 过去的时间不报错也不空转：视为「下一次 tick 就醒」，语义上等于「马上继续」。
  const delay = dueAt - Date.now();
  if (delay > AGENT_WAKE.MAX_SLEEP_MS) {
    return { error: `until is more than ${Math.floor(AGENT_WAKE.MAX_SLEEP_MS / 86_400_000)} days out; set up an automation instead of parking a turn that long` };
  }
  return {
    input: { kind: 'time' as AgentWakeKind, dueAt, reason },
    confirmation: `Parked until ${new Date(dueAt).toISOString()}. This turn ends here; you will be resumed then with your reason: ${reason}`,
  };
}

function jobWake(reason: string, args: Record<string, unknown>) {
  const jobId = readString(args, 'job_id');
  if (!jobId) return { error: 'job_id is required' };
  return {
    input: { kind: 'job' as AgentWakeKind, jobId, reason },
    confirmation: `Parked until automation "${jobId}" finishes. This turn ends here; you will be resumed then with your reason: ${reason}`,
  };
}

function eventWake(reason: string, args: Record<string, unknown>) {
  const eventName = readString(args, 'event');
  if (!eventName) return { error: 'event is required' };
  return {
    input: { kind: 'event' as AgentWakeKind, eventName, reason },
    confirmation: `Parked until event "${eventName}" happens. This turn ends here; you will be resumed then with your reason: ${reason}`,
  };
}

export const sleepUntilModule: ToolModule<Record<string, unknown>, string> = {
  schema: sleepUntilSchema,
  createHandler: () => handlerFor(sleepUntilSchema, timeWake),
};

export const wakeOnModule: ToolModule<Record<string, unknown>, string> = {
  schema: wakeOnSchema,
  createHandler: () => handlerFor(wakeOnSchema, jobWake),
};

export const wakeOnEventModule: ToolModule<Record<string, unknown>, string> = {
  schema: wakeOnEventSchema,
  createHandler: () => handlerFor(wakeOnEventSchema, eventWake),
};
