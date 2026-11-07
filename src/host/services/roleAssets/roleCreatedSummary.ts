import type { RoleDraftMeta } from './roleDraftQueue';

const CALENDAR_WRITE_TOOLS = new Set([
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
]);

/** Created-card copy derived only from the installed draft, never from a model flag. */
export function buildRoleCreatedSummary(
  draft: Pick<RoleDraftMeta, 'description' | 'tools' | 'userExpectation'>,
): { canDo: string; willNotDo: string } {
  const tools = new Set(draft.tools.map((name) => name.trim().toLowerCase()).filter(Boolean));
  const canDo = draft.description.trim()
    || draft.userExpectation?.trim()
    || '按你的要求完成这位专家负责的工作';

  if (tools.has('calendar') && ![...CALENDAR_WRITE_TOOLS].some((name) => tools.has(name))) {
    return { canDo, willNotDo: '新建、修改或删除日历事件' };
  }
  if (tools.has('mail') && !tools.has('mail_send')) {
    return { canDo, willNotDo: '替你发送邮件' };
  }
  if (tools.has('reminders') && !tools.has('reminders_create')) {
    return { canDo, willNotDo: '替你新建提醒事项' };
  }
  return { canDo, willNotDo: '未经你确认执行高风险操作' };
}
