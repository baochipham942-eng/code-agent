import { CRON_AGENT_SNAPSHOT } from '@shared/constants/memory';
import { EXTERNAL_WATCH, type ExternalWatchConfig } from '@shared/constants/feishu';
import { findRecommendedMcpServer } from '@shared/constants/mcpCatalog';
import type { CronJobDraft } from './types';
import { createDefaultCronJobDraft } from './types';

// ── Template field definition ───────────────────────────────────────

export interface TemplateField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  type?: 'text' | 'textarea';
}

// ── Template definition ─────────────────────────────────────────────

export interface CronTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string;
  scheduleLabel: string;
  featured?: boolean;
  fields: TemplateField[];
  /** 依赖的连接器 id（对齐 mcpCatalog RECOMMENDED_MCP_SERVERS.id，如 'lark'），只给真有依赖的模板填 */
  requiredConnectors?: string[];
  generate: (values: Record<string, string>) => CronJobDraft;
}

// ── Connector dependency status ─────────────────────────────────────

export interface TemplateConnectorStatus {
  id: string;
  label: string;
  connected: boolean;
}

/**
 * connectedConnectorIds 由调用方从 useMcpServerStates 派生（status === 'connected' 的 config.name 集合），
 * 这里保持纯函数不耦合 React hook，方便单测。
 */
export function getTemplateConnectorStatuses(
  template: Pick<CronTemplate, 'requiredConnectors'>,
  connectedConnectorIds: ReadonlySet<string>,
): TemplateConnectorStatus[] {
  return (template.requiredConnectors || []).map((id) => ({
    id,
    label: findRecommendedMcpServer(id)?.name || id,
    connected: connectedConnectorIds.has(id),
  }));
}

export function getMissingTemplateConnectors(
  statuses: TemplateConnectorStatus[],
): TemplateConnectorStatus[] {
  return statuses.filter((status) => !status.connected);
}

// ── Helper ──────────────────────────────────────────────────────────

function makeDraft(overrides: Partial<CronJobDraft>): CronJobDraft {
  return { ...createDefaultCronJobDraft(), ...overrides };
}

// ── Templates ───────────────────────────────────────────────────────

export const CRON_TEMPLATES: CronTemplate[] = [
  {
    id: 'daily-lookahead',
    name: '每日前瞻',
    emoji: '🗓️',
    description: '备好今天剩余时间和明天的安排',
    scheduleLabel: '工作日 15:00',
    featured: true,
    fields: [],
    generate: () =>
      makeDraft({
        name: '每日前瞻',
        description: '整理当日剩余安排、次日日程、待办与重点',
        tagsText: '前瞻, 日程, 待办',
        scheduleType: 'cron',
        cronExpression: '0 15 * * 1-5',
        cronTimezone: 'Asia/Shanghai',
        actionType: 'agent',
        agentType: 'default',
        agentPrompt:
          '请整理我今天剩余时间和明天的日程、待办与重点，标出时间冲突、临近截止事项，以及需要我提前准备或跟进的事情。',
      }),
  },
  {
    id: 'daily-review',
    name: '每日回顾',
    emoji: '✅',
    description: '回顾今天的进展和待续事项',
    scheduleLabel: '工作日 17:30',
    featured: true,
    fields: [],
    generate: () =>
      makeDraft({
        name: '每日回顾',
        description: '回顾当天进展、阻塞与待续事项',
        tagsText: '回顾, 进展, 待办',
        scheduleType: 'cron',
        cronExpression: '30 17 * * 1-5',
        cronTimezone: 'Asia/Shanghai',
        actionType: 'agent',
        agentType: 'default',
        agentPrompt:
          '请回顾我今天的工作进展，整理已完成、未完成和需要继续跟进的事项，指出阻塞、风险和明天最该优先推进的事情。',
      }),
  },
  {
    id: 'weekly-review',
    name: '每周回顾',
    emoji: '📋',
    description: '总结本周并备好下周重点',
    scheduleLabel: '每周四 17:30',
    featured: true,
    fields: [],
    generate: () =>
      makeDraft({
        name: '每周回顾',
        description: '总结本周进展并整理下周重点',
        tagsText: '周报, 回顾, 计划',
        scheduleType: 'cron',
        cronExpression: '30 17 * * 4',
        cronTimezone: 'Asia/Shanghai',
        actionType: 'agent',
        agentType: 'default',
        agentPrompt:
          '请总结我本周的主要进展、重要结果、未完成事项和风险，并结合已有日程与待办，整理下周的重点、准备事项和优先顺序。',
      }),
  },
  {
    id: 'web-change-watch',
    name: '网页更新提醒',
    emoji: '👀',
    description: '关注竞品页面、政策页或公告页的变化',
    scheduleLabel: '每天 09:00（可调整）',
    fields: [
      { key: 'url', label: '网页地址', placeholder: '粘贴要关注的网页地址', required: true },
      { key: 'schedule', label: '查看频率', placeholder: '例如：每天 9:00、每 2 小时' },
    ],
    generate: (v) => {
      const cron = parseFriendlySchedule(v.schedule);
      return makeDraft({
        name: '网页更新提醒',
        description: `关注 ${v.url} 的内容变化，有更新时整理重点`,
        tagsText: '网页关注, 信息更新',
        actionType: 'agent',
        agentType: 'default',
        agentPrompt:
          `请查看 ${v.url} 的内容有没有更新，重点留意新增内容、重要改动和需要我关注的信息。` +
          '如果有变化，请简要说明变了什么、为什么值得关注；如果没有变化，也请直接告诉我。',
        // 开变化追踪：不开的话它每次只能把当前全量内容报一遍，说不出「变了什么」
        agentContextText: JSON.stringify({ [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true }, null, 2),
        ...cron,
      });
    },
  },
  {
    id: 'feishu-calendar-conflict',
    name: '飞书日程冲突监听',
    emoji: '📅',
    description: '盯住某个飞书日历，出现时间冲突就提醒',
    scheduleLabel: '每天 09:00（可调整）',
    requiredConnectors: ['lark'],
    fields: [
      { key: 'calendarId', label: '日历 ID', placeholder: '飞书日历的 calendar_id（分享链接或调试台里取）', required: true },
      { key: 'schedule', label: '查看频率', placeholder: '例如：每天 9:00、每 2 小时' },
    ],
    generate: (v) => {
      const cron = parseFriendlySchedule(v.schedule);
      const externalWatch: ExternalWatchConfig = { source: EXTERNAL_WATCH.SOURCE_CALENDAR, calendarId: v.calendarId };
      return makeDraft({
        name: '飞书日程冲突监听',
        description: `盯住飞书日历 ${v.calendarId}，出现时间冲突就提醒`,
        tagsText: '飞书, 日程, 冲突',
        actionType: 'agent',
        agentType: 'default',
        agentPrompt:
          `请用飞书日历工具查看日历 ${v.calendarId} 今天的日程。start_time 用上文给出的「今天本地 00:00」的 Unix 秒、end_time 用「次日本地 00:00」的 Unix 秒，直接照抄别自己换算；分页条数不少于 50（飞书日历接口下限就是 50，取少了会报错）。` +
          '两两比对是否有时间重叠的冲突。' +
          '把当前所有冲突对的简短签名（两个日程的标题加时间）用 <cron_snapshot>…</cron_snapshot> 包住，供下次对比。' +
          '只有当出现【上次没有、这次新增】的冲突时，才用 <cron_alert>…</cron_alert> 包住这条新冲突的说明（谁和谁、什么时间撞了）；' +
          '如果没有新增冲突，就不要输出 <cron_alert>，直接说一句本次无新增冲突即可。',
        agentContextText: JSON.stringify({
          [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true,
          [EXTERNAL_WATCH.CONTEXT_KEY]: externalWatch,
        }, null, 2),
        ...cron,
      });
    },
  },
  {
    id: 'feishu-table-change',
    name: '飞书表格行变更监听',
    emoji: '📊',
    description: '盯住某张多维表格，有行新增或改动就提醒',
    scheduleLabel: '每天 09:00（可调整）',
    requiredConnectors: ['lark'],
    fields: [
      { key: 'baseAppToken', label: 'Base App Token', placeholder: '多维表格的 app_token', required: true },
      { key: 'tableId', label: '数据表 ID', placeholder: 'table_id（tbl 开头）', required: true },
      { key: 'schedule', label: '查看频率', placeholder: '例如：每天 9:00' },
    ],
    generate: (v) => {
      const cron = parseFriendlySchedule(v.schedule);
      const externalWatch: ExternalWatchConfig = { source: EXTERNAL_WATCH.SOURCE_TABLE, baseAppToken: v.baseAppToken, tableId: v.tableId };
      return makeDraft({
        name: '飞书表格行变更监听',
        description: `盯住多维表格 ${v.tableId} 的行变更`,
        tagsText: '飞书, 多维表格, 变更',
        actionType: 'agent',
        agentType: 'default',
        agentPrompt:
          `请用飞书多维表格的记录搜索工具（appTableRecord.search，app_token=${v.baseAppToken}、table_id=${v.tableId}）取回当前记录，` +
          '对每条记录用它的 record_id 和字段内容做一个简短指纹（record_id 对应字段内容摘要）。' +
          '把所有记录的指纹用 <cron_snapshot>…</cron_snapshot> 包住，供下次对比。' +
          '与上次快照对比，找出【新增的行】和【字段变了的行】。' +
          '只有当确有新增或改动时，才用 <cron_alert>…</cron_alert> 包住变更说明（哪几行、变了什么）；没有就不要输出 <cron_alert>，直接说一句本次无变更即可。',
        agentContextText: JSON.stringify({
          [CRON_AGENT_SNAPSHOT.ENABLED_KEY]: true,
          [EXTERNAL_WATCH.CONTEXT_KEY]: externalWatch,
        }, null, 2),
        ...cron,
      });
    },
  },
];

export const FEATURED_CRON_TEMPLATES = CRON_TEMPLATES.filter((template) => template.featured);

// ── Schedule parser ─────────────────────────────────────────────────

function parseFriendlySchedule(input?: string): Partial<CronJobDraft> {
  if (!input?.trim()) {
    return { scheduleType: 'cron', cronExpression: '0 9 * * *', cronTimezone: 'Asia/Shanghai' };
  }
  const s = input.trim().toLowerCase();

  // Direct cron expression (5-6 fields starting with number or *)
  if (/^[\d*]/.test(s) && s.split(/\s+/).length >= 5) {
    return { scheduleType: 'cron', cronExpression: input.trim(), cronTimezone: 'Asia/Shanghai' };
  }

  // "每小时" / "每 N 小时"
  const everyHour = s.match(/每\s*(\d+)?\s*小时/);
  if (everyHour) {
    return { scheduleType: 'every', everyInterval: everyHour[1] || '1', everyUnit: 'hours' };
  }

  // "每 N 分钟"
  const everyMin = s.match(/每\s*(\d+)?\s*分钟/);
  if (everyMin) {
    return { scheduleType: 'every', everyInterval: everyMin[1] || '5', everyUnit: 'minutes' };
  }

  // "每天 HH:MM" or "每天"
  const dailyAt = s.match(/每天\s*(\d{1,2})[:\s]?(\d{2})?/);
  if (dailyAt) {
    const h = dailyAt[1] || '9';
    const m = dailyAt[2] || '0';
    return { scheduleType: 'cron', cronExpression: `${m} ${h} * * *`, cronTimezone: 'Asia/Shanghai' };
  }
  if (s.includes('每天')) {
    return { scheduleType: 'cron', cronExpression: '0 9 * * *', cronTimezone: 'Asia/Shanghai' };
  }

  // Fallback: treat as cron or daily 9am
  return { scheduleType: 'cron', cronExpression: '0 9 * * *', cronTimezone: 'Asia/Shanghai' };
}
