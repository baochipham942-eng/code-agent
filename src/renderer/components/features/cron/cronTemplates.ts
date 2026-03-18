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
    id: 'web-scrape',
    name: '网页内容采集',
    emoji: '🌐',
    description: '定时抓取网页内容并保存',
    fields: [
      { key: 'url', label: '目标 URL', placeholder: 'https://example.com/feed', required: true },
      { key: 'output', label: '输出路径', placeholder: '/tmp/scraped-data.json', required: true },
      { key: 'schedule', label: '执行频率', placeholder: '每天/每小时/自定义 cron' },
    ],
    generate: (v) => {
      const cron = parseFriendlySchedule(v.schedule);
      return makeDraft({
        name: `采集 ${new URL(v.url).hostname}`,
        description: `抓取 ${v.url} 内容保存到 ${v.output}`,
        tagsText: '采集, 自动化',
        actionType: 'shell',
        shellCommand: `curl -sL "${v.url}" -o "${v.output}"`,
        ...cron,
      });
    },
  },
  {
    id: 'db-backup',
    name: '数据库备份',
    emoji: '💾',
    description: 'SQLite / PostgreSQL 定期备份',
    fields: [
      { key: 'dbPath', label: '数据库路径', placeholder: '~/Library/Application Support/code-agent/code-agent.db', required: true },
      { key: 'backupDir', label: '备份目录', placeholder: '/tmp/db-backups', required: true },
      { key: 'schedule', label: '执行频率', placeholder: '每天/每小时' },
    ],
    generate: (v) => {
      const cron = parseFriendlySchedule(v.schedule);
      const filename = 'backup-$(date +%Y%m%d-%H%M%S).db';
      return makeDraft({
        name: '数据库备份',
        description: `备份 ${v.dbPath} 到 ${v.backupDir}`,
        tagsText: '备份, 数据库',
        actionType: 'shell',
        shellCommand: `mkdir -p "${v.backupDir}" && cp "${v.dbPath}" "${v.backupDir}/${filename}"`,
        ...cron,
      });
    },
  },
  {
    id: 'api-health',
    name: 'API 健康检查',
    emoji: '🏥',
    description: '定期检测 API 可用性',
    fields: [
      { key: 'url', label: 'API 地址', placeholder: 'https://api.example.com/health', required: true },
      { key: 'interval', label: '检查间隔（分钟）', placeholder: '5' },
    ],
    generate: (v) => {
      const mins = parseInt(v.interval) || 5;
      return makeDraft({
        name: `健康检查 ${new URL(v.url).hostname}`,
        description: `每 ${mins} 分钟检查 ${v.url}`,
        tagsText: '监控, API',
        scheduleType: 'every',
        everyInterval: String(mins),
        everyUnit: 'minutes',
        actionType: 'shell',
        shellCommand: `curl -sf "${v.url}" > /dev/null && echo "OK" || echo "FAIL: ${v.url}"`,
      });
    },
  },
  {
    id: 'file-cleanup',
    name: '文件清理',
    emoji: '🧹',
    description: '自动删除过期文件',
    fields: [
      { key: 'dir', label: '目标目录', placeholder: '/tmp/logs', required: true },
      { key: 'days', label: '保留天数', placeholder: '7' },
      { key: 'pattern', label: '文件模式', placeholder: '*.log' },
    ],
    generate: (v) => {
      const days = parseInt(v.days) || 7;
      const pat = v.pattern || '*';
      return makeDraft({
        name: `清理 ${v.dir}`,
        description: `删除 ${v.dir} 中超过 ${days} 天的 ${pat} 文件`,
        tagsText: '清理, 运维',
        scheduleType: 'cron',
        cronExpression: '0 3 * * *',
        cronTimezone: 'Asia/Shanghai',
        actionType: 'shell',
        shellCommand: `find "${v.dir}" -name "${pat}" -mtime +${days} -delete -print`,
      });
    },
  },
  {
    id: 'webhook-notify',
    name: 'Webhook 通知',
    emoji: '🔔',
    description: '定时调用 Webhook（飞书/Slack/钉钉等）',
    fields: [
      { key: 'url', label: 'Webhook URL', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx', required: true },
      { key: 'message', label: '消息内容', placeholder: '每日提醒：检查系统状态', required: true },
      { key: 'schedule', label: '执行频率', placeholder: '每天 9:00' },
    ],
    generate: (v) => {
      const cron = parseFriendlySchedule(v.schedule);
      return makeDraft({
        name: 'Webhook 通知',
        description: v.message,
        tagsText: '通知, webhook',
        actionType: 'webhook',
        webhookUrl: v.url,
        webhookMethod: 'POST',
        webhookHeadersText: '{\n  "Content-Type": "application/json"\n}',
        webhookBodyText: JSON.stringify({ msg_type: 'text', content: { text: v.message } }, null, 2),
        ...cron,
      });
    },
  },
  {
    id: 'custom-script',
    name: '自定义脚本',
    emoji: '⚙️',
    description: '运行自己的脚本或命令',
    fields: [
      { key: 'command', label: '命令', placeholder: 'bash ~/scripts/my-task.sh', required: true, type: 'textarea' },
      { key: 'cwd', label: '工作目录', placeholder: '可选，默认为项目根目录' },
      { key: 'schedule', label: '执行频率', placeholder: '每天/每小时/cron 表达式' },
    ],
    generate: (v) => {
      const cron = parseFriendlySchedule(v.schedule);
      return makeDraft({
        name: '自定义任务',
        description: v.command.split('\n')[0].slice(0, 60),
        tagsText: '自定义',
        actionType: 'shell',
        shellCommand: v.command,
        shellCwd: v.cwd || '',
        ...cron,
      });
    },
  },
];

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
