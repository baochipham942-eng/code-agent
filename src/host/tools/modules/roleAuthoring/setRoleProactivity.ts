// ============================================================================
// set_role_proactivity — 对话里改角色主动性（等级/每日一次/免打扰/话题增删）
//
// 用户在角色会话或普通会话里说「以后每天只跟我说一次，别报天气」→
// 本工具算出合并后的下一份配置，用 forceConfirm 审批卡把「旧 -> 新」
// 用大白话复述给用户，用户点允许才写。写路径与设置页 IPC（roles setProactivity）
// 同一份真源 writeRoleProactivityConfig，含 cadence cron 立即同步。
// 无人值守（cron/巡检/channel）会话不可用：改主动性必须用户在场亲自确认。
// ============================================================================

import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { ROLE_PROACTIVITY } from '../../../../shared/constants';
import { formatCronExpressionLabel } from '../../../../shared/cronHumanize';
import { readPersistedExpertThread } from '../../../../shared/contract/expertThread';
import type { RoleProactivityConfig, RoleProactivityLevel } from '../../../../shared/contract/roleAssets';
import { getPermissionModeManager } from '../../../permissions/modes';
import { getSessionManager } from '../../../services/infra/sessionManager';
import { isPersistentRole, listPersistentRoles } from '../../../services/roleAssets/roleAssetService';
import { resolveRoleProactivityConfig } from '../../../services/roleAssets/roleProactivity';
import { writeRoleProactivityConfig } from '../../../services/roleAssets/roleProactivityWrite';
import { setRoleProactivitySchema as schema } from './setRoleProactivity.schema';

const LEVEL_LABELS: Record<RoleProactivityLevel, string> = {
  silent: '静默（不主动）',
  daily: '每日简报',
  realtime: '实时介入',
};

const VALID_LEVELS = new Set<RoleProactivityLevel>(['silent', 'daily', 'realtime']);

function levelLabel(level: RoleProactivityLevel): string {
  return LEVEL_LABELS[level] ?? level;
}

/** cadence 是 croner 6 段表达式（含秒位），humanize 只认 5 段——秒位为 0 时去掉再翻，翻不了回退原文。 */
function cadenceLabel(cadence: string | undefined): string {
  if (!cadence) return '（无定时）';
  const fields = cadence.trim().split(/\s+/);
  const fiveField = fields.length === 6 && fields[0] === '0' ? fields.slice(1).join(' ') : cadence;
  return formatCronExpressionLabel(fiveField, undefined, 'zh');
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function quietHoursEqual(
  a: RoleProactivityConfig['quietHours'],
  b: RoleProactivityConfig['quietHours'],
): boolean {
  return a?.start === b?.start && a?.end === b?.end;
}

function parseQuietHours(value: unknown): { ok: true; quietHours: RoleProactivityConfig['quietHours'] } | { ok: false; error: string } {
  if (value === null) return { ok: true, quietHours: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'quiet_hours must be {start,end} (HH:mm) or null' };
  }
  const { start, end } = value as { start?: unknown; end?: unknown };
  if (typeof start !== 'string' || typeof end !== 'string') {
    return { ok: false, error: 'quiet_hours must contain start/end in HH:mm format' };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) {
    return { ok: false, error: 'quiet_hours start/end must be HH:mm (e.g. "22:00")' };
  }
  if (start === end) {
    return { ok: false, error: 'quiet_hours start and end must differ (empty window is invalid)' };
  }
  return { ok: true, quietHours: { start, end } };
}

/** 读会话的专家 thread 标记，拿本 thread 的角色作为默认目标。 */
async function resolveExpertThreadRoleId(sessionId: string): Promise<string | null> {
  try {
    const session = await getSessionManager().getSession(sessionId);
    return readPersistedExpertThread(session?.metadata)?.roleId ?? null;
  } catch {
    return null;
  }
}

function mergeTopics(current: string[] | undefined, remove: string[] | undefined, add: string[] | undefined): string[] {
  const removeSet = new Set((remove ?? []).map((topic) => topic.toLowerCase()));
  const kept = (current ?? []).filter((topic) => !removeSet.has(topic.toLowerCase()));
  const addSet = new Set(kept.map((topic) => topic.toLowerCase()));
  const appended: string[] = [];
  for (const topic of add ?? []) {
    if (!addSet.has(topic.toLowerCase())) {
      addSet.add(topic.toLowerCase());
      appended.push(topic);
    }
  }
  return [...kept, ...appended];
}

export async function executeSetRoleProactivity(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  // 无人值守（cron/巡检/channel/语音派）一律挡在审批之前：这类会话里 forceConfirm
  // 会停车挂起成收件箱待办（B2），改主动性这种用户偏好不该在用户不在场时排队等人。
  if (getPermissionModeManager().isUnattendedSession(ctx.sessionId)) {
    return {
      ok: false,
      error: 'set_role_proactivity is only available in sessions the user personally attends; scheduled/wake/unattended runs must not change proactivity. Tell the user to adjust it in the role conversation.',
      code: 'UNATTENDED_UNSUPPORTED',
    };
  }

  // ---- 参数解析与校验（审批之前，坏参数不该弹卡） ----
  const explicitRoleId = typeof args.roleId === 'string' ? args.roleId.trim() : '';
  const roleId = explicitRoleId || (await resolveExpertThreadRoleId(ctx.sessionId)) || '';
  const persistentRoles = await listPersistentRoles();
  if (!roleId) {
    return {
      ok: false,
      error: persistentRoles.length > 0
        ? `roleId is required outside an expert thread. Available persistent roles: ${persistentRoles.join(', ')}`
        : 'roleId is required outside an expert thread (no persistent roles on this machine)',
      code: 'INVALID_ARGS',
    };
  }
  if (!(await isPersistentRole(roleId))) {
    return {
      ok: false,
      error: `Unknown role "${roleId}". Available persistent roles: ${persistentRoles.length > 0 ? persistentRoles.join(', ') : '(none)'}`,
      code: 'INVALID_ARGS',
    };
  }

  const levelArg = typeof args.level === 'string' ? args.level : undefined;
  if (levelArg !== undefined && !VALID_LEVELS.has(levelArg as RoleProactivityLevel)) {
    return { ok: false, error: 'level must be one of silent|daily|realtime', code: 'INVALID_ARGS' };
  }
  const onceADay = args.once_a_day === true;
  if (onceADay && levelArg !== undefined && levelArg !== 'daily') {
    return { ok: false, error: 'once_a_day conflicts with level: once_a_day implies level=daily, pass only one of them', code: 'INVALID_ARGS' };
  }
  const addExclude = toStringArray(args.add_exclude);
  const removeExclude = toStringArray(args.remove_exclude);
  const addInclude = toStringArray(args.add_include);
  const removeInclude = toStringArray(args.remove_include);
  const quietHoursParse = args.quiet_hours === undefined ? { ok: true as const, quietHours: undefined } : parseQuietHours(args.quiet_hours);
  if (!quietHoursParse.ok) {
    return { ok: false, error: quietHoursParse.error, code: 'INVALID_ARGS' };
  }

  // ---- 读当前配置，算合并后的下一份 ----
  const current = await resolveRoleProactivityConfig(roleId);
  const nextLevel: RoleProactivityLevel = onceADay
    ? 'daily'
    : ((levelArg as RoleProactivityLevel | undefined) ?? current.level);
  // once_a_day 显式落每日简报 cron（否则旧的 3 小时一响这类自定义 cron 会残留）；
  // 其余场景沿用当前 cadence（有效值不变，纯 level 写不覆盖自定义节奏）。
  const nextCadence = onceADay ? ROLE_PROACTIVITY.DAILY_BRIEF_CRON : current.cadence;
  const nextTopicsInclude = mergeTopics(current.topicsInclude, removeInclude, addInclude);
  const nextTopicsExclude = mergeTopics(current.topicsExclude, removeExclude, addExclude);
  const nextQuietHours = quietHoursParse.quietHours !== undefined ? quietHoursParse.quietHours : current.quietHours;

  const unchanged = nextLevel === current.level
    && nextCadence === current.cadence
    && quietHoursEqual(nextQuietHours, current.quietHours)
    && JSON.stringify(nextTopicsInclude) === JSON.stringify(current.topicsInclude ?? [])
    && JSON.stringify(nextTopicsExclude) === JSON.stringify(current.topicsExclude ?? []);
  if (unchanged) {
    return {
      ok: true,
      output: `角色「${roleId}」的主动性配置没有需要变更的内容，未弹出确认卡。当前：${levelLabel(current.level)}${current.cadence ? `（${cadenceLabel(current.cadence)}）` : ''}。`,
      meta: { roleId, changed: false },
    };
  }

  // ---- 审批卡文案：逐字段「旧 -> 新」，大白话 ----
  const lines: string[] = [`角色「${roleId}」主动性调整：`];
  if (nextLevel !== current.level || nextCadence !== current.cadence) {
    lines.push(
      `打扰频率：${levelLabel(current.level)}${current.cadence ? `（${cadenceLabel(current.cadence)}）` : ''} -> ${levelLabel(nextLevel)}${nextCadence ? `（${cadenceLabel(nextCadence)}）` : ''}`,
    );
  }
  const topicDiff = (label: string, from: string[] | undefined, to: string[]): void => {
    const fromList = from ?? [];
    const added = to.filter((topic) => !fromList.includes(topic));
    const removed = fromList.filter((topic) => !to.includes(topic));
    if (added.length > 0) lines.push(`${label}：+ ${added.join('、')}`);
    if (removed.length > 0) lines.push(`${label}：- ${removed.join('、')}`);
  };
  topicDiff('永远别提', current.topicsExclude, nextTopicsExclude);
  topicDiff('想听什么', current.topicsInclude, nextTopicsInclude);
  if (!quietHoursEqual(nextQuietHours, current.quietHours)) {
    lines.push(
      `免打扰时段：${current.quietHours ? `${current.quietHours.start} 至 ${current.quietHours.end}` : '未设置'} -> ${nextQuietHours ? `${nextQuietHours.start} 至 ${nextQuietHours.end}` : '未设置'}`,
    );
  } else {
    // 没动的免打扰也写明「未变」，避免用户以为这张卡把整份设置换掉了。
    lines.push('免打扰时段：未变');
  }
  const restatement = lines.join('\n');

  const permit = await canUseTool(
    schema.name,
    args,
    restatement,
    {
      sessionId: ctx.sessionId,
      forceConfirm: true,
      // 非文件工具走通用展开卡：file_write 会默认折叠旧->新复述，还会被 CLI 的编辑类授权命中。
      type: 'command',
      tool: schema.name,
      // shadowAdapter 优先用 hint.reason 填审批请求；第 3 参只在 hint.reason 缺省时才落到卡上。
      // 两处都放同一份旧->新复述，确认卡（CLI 直接渲染 reason；桌面默认展开 preview）才看得到。
      reason: restatement,
      dangerLevel: 'normal',
      details: {
        roleId,
        before: { level: current.level, cadence: current.cadence ?? null, quietHours: current.quietHours ?? null, topicsInclude: current.topicsInclude ?? [], topicsExclude: current.topicsExclude ?? [] },
        after: { level: nextLevel, cadence: nextCadence ?? null, quietHours: nextQuietHours ?? null, topicsInclude: nextTopicsInclude, topicsExclude: nextTopicsExclude },
        // 桌面审批卡不把 reason 画进问句（问句按 type 生成）。展开详情读的是 preview.summary。
        preview: { type: 'generic' as const, summary: restatement },
        // 停车收件箱的参数预览只拼 command/path/url/changes，不读 preview。
        changes: restatement,
      },
    },
  );
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: `${schema.name}(${roleId})` });
  try {
    const { proactivity, synced } = await writeRoleProactivityConfig(roleId, {
      level: nextLevel,
      cadence: nextCadence,
      quietHours: nextQuietHours,
      topicsInclude: nextTopicsInclude,
      topicsExclude: nextTopicsExclude,
    });
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output:
        `已按用户确认更新「${roleId}」的主动性：\n${restatement}\n` +
        `定时任务同步：${synced ? `已同步（注册/更新 ${synced.registered.length}、移除 ${synced.removed.length}）` : '本次未同步（下次启动兜底）'}。` +
        '请用一句话向用户确认改动已生效。',
      meta: { roleId, changed: true, proactivity, synced },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'ROLE_PROACTIVITY_WRITE_FAILED',
    };
  }
}

class SetRoleProactivityHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ) {
    return executeSetRoleProactivity(args, ctx, canUseTool, onProgress);
  }
}

export const setRoleProactivityModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new SetRoleProactivityHandler(),
};
