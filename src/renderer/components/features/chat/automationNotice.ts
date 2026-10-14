import type { CronScheduleConfig } from '@shared/contract';

export function formatCronScheduleLabel(schedule: CronScheduleConfig): string {
  switch (schedule.type) {
    case 'every': {
      const unitLabel = {
        seconds: '秒',
        minutes: '分钟',
        hours: '小时',
        days: '天',
      } satisfies Record<string, string>;
      return `每 ${schedule.interval} ${unitLabel[schedule.unit]}`;
    }
    case 'at': {
      const ts = typeof schedule.datetime === 'number' ? schedule.datetime : Date.parse(String(schedule.datetime));
      return Number.isFinite(ts)
        ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '一次性';
    }
    case 'cron':
      return schedule.timezone ? `${schedule.expression} · ${schedule.timezone}` : schedule.expression;
    default:
      return '按配置';
  }
}
