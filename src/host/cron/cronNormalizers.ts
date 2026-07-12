// ============================================================================
// CronService - row/schedule/action normalizers & type guards
// 纯函数：把数据库行、schedule、action 等 unknown 输入规整成强类型契约。
// 从 cronService.ts 抽出以收敛文件体积，无行为变更。
// ============================================================================

import type {
  CronJobDefinition,
  CronJobStatus,
  CronScheduleType,
  CronScheduleConfig,
  CronJobAction,
} from '../../shared/contract/cron';

export interface CronAgentActionResult {
  agentType: string;
  prompt: string;
  result: unknown;
  sessionId: string;
}

export interface CronExecutionRow {
  id: string;
  job_id: string;
  session_id?: string | null;
  status: CronJobStatus;
  scheduled_at: number;
  started_at?: number | null;
  completed_at?: number | null;
  duration?: number | null;
  result?: string | null;
  error?: string | null;
  retry_attempt: number;
  exit_code?: number | null;
}

const CRON_JOB_STATUSES: readonly CronJobStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'paused',
  'interrupted',
];

export const SUPPORTED_EVERY_TIME_UNITS = ['seconds', 'minutes', 'hours', 'days'] as const;
export type SupportedEveryTimeUnit = typeof SUPPORTED_EVERY_TIME_UNITS[number];

export function isCronAgentActionResult(value: unknown): value is CronAgentActionResult {
  return isRecord(value) && typeof value.sessionId === 'string';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readOptionalNumberField(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = readNumberField(record, key);
  return value === 0 ? undefined : value;
}

export function readNullableStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

export function readNullableNumberField(record: Record<string, unknown>, key: string): number | null {
  return readNumberField(record, key) ?? null;
}

export function parseJsonValue(raw: unknown): unknown | undefined {
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function isCronScheduleType(value: unknown): value is CronScheduleType {
  return value === 'at' || value === 'every' || value === 'cron';
}

export function isCronJobStatus(value: unknown): value is CronJobStatus {
  return CRON_JOB_STATUSES.includes(value as CronJobStatus);
}

export function isTimeUnit(value: unknown): value is SupportedEveryTimeUnit {
  return SUPPORTED_EVERY_TIME_UNITS.includes(value as SupportedEveryTimeUnit);
}

export function isFiniteScheduleTimestamp(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

export function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      return undefined;
    }
    normalized[key] = item;
  }
  return normalized;
}

export function normalizeUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function normalizeTags(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

export function normalizeSchedule(value: unknown): CronScheduleConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.type) {
    case 'at': {
      if (!isFiniteScheduleTimestamp(value.datetime)) {
        return null;
      }
      return { type: 'at', datetime: value.datetime };
    }

    case 'every': {
      const interval = readNumberField(value, 'interval');
      if (!interval || !isTimeUnit(value.unit)) {
        return null;
      }

      const schedule: CronScheduleConfig = {
        type: 'every',
        interval,
        unit: value.unit,
      };

      if (isFiniteScheduleTimestamp(value.startAt)) {
        schedule.startAt = value.startAt;
      }
      if (isFiniteScheduleTimestamp(value.endAt)) {
        schedule.endAt = value.endAt;
      }
      return schedule;
    }

    case 'cron': {
      if (typeof value.expression !== 'string') {
        return null;
      }

      return {
        type: 'cron',
        expression: value.expression,
        timezone: typeof value.timezone === 'string' ? value.timezone : undefined,
      };
    }

    default:
      return null;
  }
}

export function assertSupportedEveryScheduleUnit(schedule: CronScheduleConfig): void {
  if (schedule.type !== 'every' || isTimeUnit(schedule.unit)) return;
  throw new Error(
    `Unsupported interval unit "${schedule.unit}". CronService supports seconds, minutes, hours, and days; use a cron expression for weekly calendar schedules.`,
  );
}

export function normalizeAction(value: unknown): CronJobAction | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.type) {
    case 'shell': {
      if (typeof value.command !== 'string') {
        return null;
      }
      return {
        type: 'shell',
        command: value.command,
        cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
        env: normalizeStringRecord(value.env),
        usePty: typeof value.usePty === 'boolean' ? value.usePty : undefined,
      };
    }

    case 'tool': {
      if (typeof value.toolName !== 'string') {
        return null;
      }
      return {
        type: 'tool',
        toolName: value.toolName,
        parameters: normalizeUnknownRecord(value.parameters) ?? {},
      };
    }

    case 'agent': {
      if (typeof value.agentType !== 'string' || typeof value.prompt !== 'string') {
        return null;
      }
      return {
        type: 'agent',
        agentType: value.agentType,
        prompt: value.prompt,
        context: normalizeUnknownRecord(value.context),
      };
    }

    case 'webhook': {
      if (
        typeof value.url !== 'string' ||
        (value.method !== 'GET' &&
          value.method !== 'POST' &&
          value.method !== 'PUT' &&
          value.method !== 'DELETE')
      ) {
        return null;
      }
      return {
        type: 'webhook',
        url: value.url,
        method: value.method,
        headers: normalizeStringRecord(value.headers),
        body: value.body,
      };
    }

    case 'ipc': {
      if (typeof value.channel !== 'string') {
        return null;
      }
      return {
        type: 'ipc',
        channel: value.channel,
        payload: value.payload,
      };
    }

    case 'memory-consolidation': {
      return {
        type: 'memory-consolidation',
        dryRun: typeof value.dryRun === 'boolean' ? value.dryRun : undefined,
      };
    }

    case 'role-wake': {
      if (typeof value.roleId !== 'string') {
        return null;
      }
      return {
        type: 'role-wake',
        roleId: value.roleId,
      };
    }

    default:
      return null;
  }
}

export function normalizeCronJobRow(row: unknown): CronJobDefinition | null {
  if (!isRecord(row)) {
    return null;
  }

  const id = readStringField(row, 'id');
  const name = readStringField(row, 'name');
  const scheduleType = row.schedule_type;
  const createdAt = readNumberField(row, 'created_at');
  const updatedAt = readNumberField(row, 'updated_at');
  const schedule = normalizeSchedule(parseJsonValue(row.schedule));
  const action = normalizeAction(parseJsonValue(row.action));

  if (
    !id ||
    !name ||
    !isCronScheduleType(scheduleType) ||
    createdAt === undefined ||
    updatedAt === undefined ||
    !schedule ||
    !action
  ) {
    return null;
  }

  return {
    id,
    name,
    description: readStringField(row, 'description') || undefined,
    scheduleType,
    schedule,
    action,
    enabled: row.enabled === 1 || row.enabled === true,
    maxRetries: readOptionalNumberField(row, 'max_retries'),
    retryDelay: readOptionalNumberField(row, 'retry_delay'),
    timeout: readOptionalNumberField(row, 'timeout'),
    tags: normalizeTags(parseJsonValue(row.tags)),
    metadata: normalizeUnknownRecord(parseJsonValue(row.metadata)),
    createdAt,
    updatedAt,
  };
}

export function normalizeCronExecutionRow(row: unknown): CronExecutionRow | null {
  if (!isRecord(row)) {
    return null;
  }

  const id = readStringField(row, 'id');
  const jobId = readStringField(row, 'job_id');
  const status = row.status;
  const scheduledAt = readNumberField(row, 'scheduled_at');
  const retryAttempt = readNumberField(row, 'retry_attempt');

  if (
    !id ||
    !jobId ||
    !isCronJobStatus(status) ||
    scheduledAt === undefined ||
    retryAttempt === undefined
  ) {
    return null;
  }

  return {
    id,
    job_id: jobId,
    session_id: readNullableStringField(row, 'session_id'),
    status,
    scheduled_at: scheduledAt,
    started_at: readNullableNumberField(row, 'started_at'),
    completed_at: readNullableNumberField(row, 'completed_at'),
    duration: readNullableNumberField(row, 'duration'),
    result: readNullableStringField(row, 'result'),
    error: readNullableStringField(row, 'error'),
    retry_attempt: retryAttempt,
    exit_code: readNullableNumberField(row, 'exit_code'),
  };
}
