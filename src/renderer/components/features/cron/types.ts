import type {
  AgentAction,
  CronJobDefinition,
  CronJobExecution,
  CronJobStatus,
  EveryScheduleConfig,
  IpcAction,
  ShellAction,
  ToolAction,
  WebhookAction,
} from '@shared/types';

export interface CronJobDraft {
  name: string;
  description: string;
  enabled: boolean;
  tagsText: string;
  maxRetries: string;
  retryDelay: string;
  timeout: string;
  scheduleType: 'at' | 'every' | 'cron';
  atDatetime: string;
  everyInterval: string;
  everyUnit: EveryScheduleConfig['unit'];
  everyStartAt: string;
  everyEndAt: string;
  cronExpression: string;
  cronTimezone: string;
  actionType: 'shell' | 'tool' | 'agent' | 'webhook' | 'ipc';
  shellCommand: string;
  shellCwd: string;
  shellUsePty: boolean;
  toolName: string;
  toolParametersText: string;
  agentType: string;
  agentPrompt: string;
  agentContextText: string;
  webhookUrl: string;
  webhookMethod: WebhookAction['method'];
  webhookHeadersText: string;
  webhookBodyText: string;
  ipcChannel: string;
  ipcPayloadText: string;
}

export function createDefaultCronJobDraft(): CronJobDraft {
  return {
    name: '',
    description: '',
    enabled: true,
    tagsText: '',
    maxRetries: '0',
    retryDelay: '',
    timeout: '',
    scheduleType: 'every',
    atDatetime: '',
    everyInterval: '1',
    everyUnit: 'hours',
    everyStartAt: '',
    everyEndAt: '',
    cronExpression: '0 * * * *',
    cronTimezone: '',
    actionType: 'shell',
    shellCommand: '',
    shellCwd: '',
    shellUsePty: false,
    toolName: '',
    toolParametersText: '{}',
    agentType: '',
    agentPrompt: '',
    agentContextText: '{}',
    webhookUrl: '',
    webhookMethod: 'POST',
    webhookHeadersText: '{}',
    webhookBodyText: '{}',
    ipcChannel: '',
    ipcPayloadText: '{}',
  };
}

function toInputDateTime(value?: string | number): string {
  if (value == null) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const tzOffset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - tzOffset * 60 * 1000);
  return localDate.toISOString().slice(0, 16);
}

function stringifyJson(value: unknown): string {
  if (value == null) return '{}';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '{}';
  }
}

export function buildDraftFromJob(job: CronJobDefinition): CronJobDraft {
  const draft = createDefaultCronJobDraft();
  draft.name = job.name;
  draft.description = job.description || '';
  draft.enabled = job.enabled;
  draft.tagsText = job.tags?.join(', ') || '';
  draft.maxRetries = job.maxRetries != null ? String(job.maxRetries) : '0';
  draft.retryDelay = job.retryDelay != null ? String(job.retryDelay) : '';
  draft.timeout = job.timeout != null ? String(job.timeout) : '';
  draft.scheduleType = job.scheduleType;

  if (job.schedule.type === 'at') {
    draft.atDatetime = toInputDateTime(job.schedule.datetime);
  } else if (job.schedule.type === 'every') {
    draft.everyInterval = String(job.schedule.interval);
    draft.everyUnit = job.schedule.unit;
    draft.everyStartAt = toInputDateTime(job.schedule.startAt);
    draft.everyEndAt = toInputDateTime(job.schedule.endAt);
  } else if (job.schedule.type === 'cron') {
    draft.cronExpression = job.schedule.expression;
    draft.cronTimezone = job.schedule.timezone || '';
  }

  switch (job.action.type) {
    case 'shell': {
      const action = job.action as ShellAction;
      draft.actionType = 'shell';
      draft.shellCommand = action.command;
      draft.shellCwd = action.cwd || '';
      draft.shellUsePty = !!action.usePty;
      break;
    }
    case 'tool': {
      const action = job.action as ToolAction;
      draft.actionType = 'tool';
      draft.toolName = action.toolName;
      draft.toolParametersText = stringifyJson(action.parameters);
      break;
    }
    case 'agent': {
      const action = job.action as AgentAction;
      draft.actionType = 'agent';
      draft.agentType = action.agentType;
      draft.agentPrompt = action.prompt;
      draft.agentContextText = stringifyJson(action.context);
      break;
    }
    case 'webhook': {
      const action = job.action as WebhookAction;
      draft.actionType = 'webhook';
      draft.webhookUrl = action.url;
      draft.webhookMethod = action.method;
      draft.webhookHeadersText = stringifyJson(action.headers);
      draft.webhookBodyText = stringifyJson(action.body);
      break;
    }
    case 'ipc': {
      const action = job.action as IpcAction;
      draft.actionType = 'ipc';
      draft.ipcChannel = action.channel;
      draft.ipcPayloadText = stringifyJson(action.payload);
      break;
    }
  }

  return draft;
}

function parseOptionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

function parseJsonValue(value: string, fieldName: string): Record<string, unknown> | unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }
}

export function buildCronJobInput(draft: CronJobDraft): Omit<CronJobDefinition, 'id' | 'createdAt' | 'updatedAt'> {
  if (!draft.name.trim()) {
    throw new Error('任务名称不能为空');
  }

  const common = {
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    enabled: draft.enabled,
    maxRetries: parseOptionalNumber(draft.maxRetries) ?? 0,
    retryDelay: parseOptionalNumber(draft.retryDelay),
    timeout: parseOptionalNumber(draft.timeout),
    tags: draft.tagsText
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    metadata: {},
  };

  let schedule: CronJobDefinition['schedule'];
  if (draft.scheduleType === 'at') {
    if (!draft.atDatetime) {
      throw new Error('请选择执行时间');
    }
    schedule = {
      type: 'at',
      datetime: new Date(draft.atDatetime).toISOString(),
    };
  } else if (draft.scheduleType === 'every') {
    const interval = parseOptionalNumber(draft.everyInterval);
    if (!interval || interval <= 0) {
      throw new Error('间隔必须大于 0');
    }
    schedule = {
      type: 'every',
      interval,
      unit: draft.everyUnit,
      startAt: draft.everyStartAt ? new Date(draft.everyStartAt).toISOString() : undefined,
      endAt: draft.everyEndAt ? new Date(draft.everyEndAt).toISOString() : undefined,
    };
  } else {
    if (!draft.cronExpression.trim()) {
      throw new Error('Cron 表达式不能为空');
    }
    schedule = {
      type: 'cron',
      expression: draft.cronExpression.trim(),
      timezone: draft.cronTimezone.trim() || undefined,
    };
  }

  let action: CronJobDefinition['action'];
  if (draft.actionType === 'shell') {
    if (!draft.shellCommand.trim()) {
      throw new Error('Shell 命令不能为空');
    }
    action = {
      type: 'shell',
      command: draft.shellCommand.trim(),
      cwd: draft.shellCwd.trim() || undefined,
      usePty: draft.shellUsePty,
    };
  } else if (draft.actionType === 'tool') {
    if (!draft.toolName.trim()) {
      throw new Error('Tool 名称不能为空');
    }
    action = {
      type: 'tool',
      toolName: draft.toolName.trim(),
      parameters: parseJsonValue(draft.toolParametersText, 'Tool 参数') as Record<string, unknown>,
    };
  } else if (draft.actionType === 'agent') {
    if (!draft.agentType.trim()) {
      throw new Error('Agent 类型不能为空');
    }
    if (!draft.agentPrompt.trim()) {
      throw new Error('Prompt 不能为空');
    }
    action = {
      type: 'agent',
      agentType: draft.agentType.trim(),
      prompt: draft.agentPrompt.trim(),
      context: parseJsonValue(draft.agentContextText, 'Agent context') as Record<string, unknown>,
    };
  } else if (draft.actionType === 'webhook') {
    if (!draft.webhookUrl.trim()) {
      throw new Error('Webhook URL 不能为空');
    }
    action = {
      type: 'webhook',
      url: draft.webhookUrl.trim(),
      method: draft.webhookMethod,
      headers: parseJsonValue(draft.webhookHeadersText, 'Webhook headers') as Record<string, string>,
      body: parseJsonValue(draft.webhookBodyText, 'Webhook body'),
    };
  } else {
    if (!draft.ipcChannel.trim()) {
      throw new Error('IPC channel 不能为空');
    }
    action = {
      type: 'ipc',
      channel: draft.ipcChannel.trim(),
      payload: parseJsonValue(draft.ipcPayloadText, 'IPC payload'),
    };
  }

  return {
    ...common,
    scheduleType: draft.scheduleType,
    schedule,
    action,
  };
}

export function formatDateTime(value?: string | number): string {
  if (value == null) return '未设置';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '无效时间';
  return date.toLocaleString();
}

export function formatDuration(ms?: number): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

const UNIT_LABELS: Record<string, string> = {
  seconds: '秒',
  minutes: '分钟',
  hours: '小时',
  days: '天',
};

export function formatScheduleSummary(job: CronJobDefinition): string {
  switch (job.schedule.type) {
    case 'at':
      return `一次性 · ${formatDateTime(job.schedule.datetime)}`;
    case 'every': {
      const unit = UNIT_LABELS[job.schedule.unit] || job.schedule.unit;
      return `每 ${job.schedule.interval} ${unit}`;
    }
    case 'cron':
      return job.schedule.timezone
        ? `${job.schedule.expression} · ${job.schedule.timezone}`
        : job.schedule.expression;
    default:
      return job.scheduleType;
  }
}

const SCHEDULE_TYPE_LABELS: Record<string, string> = {
  at: '一次性',
  every: '循环',
  cron: 'Cron',
};

export function formatScheduleType(type: string): string {
  return SCHEDULE_TYPE_LABELS[type] || type;
}

export function formatActionSummary(job: CronJobDefinition): string {
  switch (job.action.type) {
    case 'shell':
      return job.action.command;
    case 'tool':
      return `${job.action.toolName}()`;
    case 'agent':
      return `${job.action.agentType} agent`;
    case 'webhook':
      return `${job.action.method} ${job.action.url}`;
    case 'ipc':
      return job.action.channel;
    default:
      return (job.action as { type: string }).type;
  }
}

export function getExecutionStatusMeta(status: CronJobStatus): { label: string; className: string } {
  switch (status) {
    case 'completed':
      return { label: '成功', className: 'text-emerald-300 bg-emerald-500/10' };
    case 'running':
      return { label: '运行中', className: 'text-blue-300 bg-blue-500/10' };
    case 'failed':
      return { label: '失败', className: 'text-red-300 bg-red-500/10' };
    case 'cancelled':
      return { label: '已取消', className: 'text-zinc-300 bg-zinc-500/10' };
    case 'paused':
      return { label: '已暂停', className: 'text-yellow-300 bg-yellow-500/10' };
    default:
      return { label: '待执行', className: 'text-zinc-300 bg-zinc-500/10' };
  }
}

export function prettyJson(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getLatestExecutionStatus(
  execution?: CronJobExecution | null
): { label: string; className: string } {
  if (!execution) {
    return { label: '未执行', className: 'text-zinc-300 bg-zinc-500/10' };
  }
  return getExecutionStatusMeta(execution.status);
}
