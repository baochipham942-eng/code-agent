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
  generate: (values: Record<string, string>) => CronJobDraft;
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
