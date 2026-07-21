import type {
  CronScheduleConfig,
  Message,
  SessionAutomationEventKind,
  SessionAutomationNextStageConfig,
  SessionAutomationStatus,
  SessionAutomationType,
} from '@shared/contract';

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

export function formatLoopIntervalLabel(intervalMs?: number): string {
  if (!intervalMs) return '自定步调';
  const seconds = Math.round(intervalMs / 1000);
  if (seconds < 60) return `每 ${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `每 ${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return `每 ${hours} 小时`;
}

export interface AutomationNoticePayload {
  automationId: string;
  automationType: SessionAutomationType;
  event: SessionAutomationEventKind;
  sourceSessionId: string;
  sourceRefId?: string;
  resultSessionId?: string;
  status?: SessionAutomationStatus;
  title: string;
  cadenceLabel?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  handoffPrompt?: string;
  nextStage?: SessionAutomationNextStageConfig;
  content?: string;
}

function statusLabel(status?: SessionAutomationStatus): string {
  switch (status) {
    case 'active': return '已启用';
    case 'running': return '运行中';
    case 'completed': return '已完成';
    case 'pending_review': return '待过目';
    case 'failed': return '失败';
    case 'paused': return '已暂停';
    case 'cancelled': return '已停止';
    case 'skipped': return '已跳过';
    case 'archived': return '已归档';
    default: return '已记录';
  }
}

function formatTimestamp(ts?: number): string | undefined {
  if (!ts) return undefined;
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function defaultContent(payload: AutomationNoticePayload): string {
  const eventText = payload.event === 'created'
    ? '自动化已创建'
    : payload.event === 'stage_ready'
      ? '阶段已就绪'
      : `自动化${statusLabel(payload.status)}`;
  const lines = [`${eventText}：${payload.title}`];
  if (payload.cadenceLabel) lines.push(`频率：${payload.cadenceLabel}`);
  const nextRun = formatTimestamp(payload.nextRunAt);
  if (nextRun) lines.push(`下次运行：${nextRun}`);
  if (payload.resultSessionId) lines.push(`结果会话：${payload.resultSessionId}`);
  if (payload.status) lines.push(`状态：${statusLabel(payload.status)}`);
  return lines.join('\n');
}

export function buildAutomationNoticeMessage(payload: AutomationNoticePayload): Message {
  return {
    id: `automation:${payload.event}:${payload.automationId}`,
    role: 'assistant',
    source: 'automation',
    content: payload.content ?? defaultContent(payload),
    timestamp: Date.now(),
    isMeta: true,
    metadata: {
      automation: {
        automationId: payload.automationId,
        automationType: payload.automationType,
        event: payload.event,
        sourceSessionId: payload.sourceSessionId,
        sourceRefId: payload.sourceRefId,
        resultSessionId: payload.resultSessionId,
        status: payload.status,
        title: payload.title,
        cadenceLabel: payload.cadenceLabel,
        nextRunAt: payload.nextRunAt,
        lastRunAt: payload.lastRunAt,
        handoffPrompt: payload.handoffPrompt,
        nextStage: payload.nextStage,
      },
    },
  };
}
