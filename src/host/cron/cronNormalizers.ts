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
  CronExecutionTrigger,
} from '../../shared/contract/cron';
import { CRON_GUARDRAILS, CRON_EVENT_TRIGGER, CRON_URGENCY_CRITERIA, EXTERNAL_WATCH } from '../../shared/constants';
import { extractCronAlertText, parseCronRunDigest, type CronRunDigest } from '../../shared/cronRunDigest';
import { declaresCronUrgencyQuiet, parseUrgencyHeader } from '../../shared/cronUrgency';
import type { CronUrgency } from '../../shared/contract/sessionAutomation';

export interface CronAgentActionResult {
  agentType: string;
  prompt: string;
  result: unknown;
  sessionId: string;
  digest?: CronRunDigest;
  /** 结果头部行解析出的紧急档位（N-CRON-INBOX-URGENCY-TIER），供待过目标记透传。 */
  urgency?: CronUrgency;
  /** 头部行存在但值不合法时的整行原文（归 fyi 时保留给用户看）。 */
  urgencyRaw?: string;
  /**
   * notifyWhen 判据未满足的安静成功轮（N-CRON-RESTATE-HUMAN-WHEN）：跳过完成
   * 系统通知与通道推送。与 skipped 不同——执行仍 completed、仍进历史与待过目
   * 收件箱，只是不打扰。只在成功路径打上；失败通知永不受它约束。
   */
  notifySuppressed?: boolean;
  /**
   * notifyWhen 满足轮从 <cron_alert> 提取的一句话原因（N-CRON-RESTATE-HUMAN-WHEN-FU1）：
   * 完成系统通知正文用它替代通用「定时任务已完成」，让被打断的用户直接看到为何而通知。
   * 只在判据设置、非安静轮且提取非空时打上；空 <cron_alert></cron_alert> 不落键，
   * 通知回落通用文案（永不空正文）。无 notifyWhen 的任务（含 external-watch）恒无此键。
   */
  alertReason?: string;
  /** 本次运行实测成本（USD，N-CRON-RUN-LEDGER-VISIBLE）：scoped 计量器读数；无模型调用时缺省。 */
  costUsd?: number;
}

/** 执行结果是否带「notifyWhen 未满足」的安静标记（通知门用，见 cronFailurePolicy）。 */
export function isNotifySuppressedResult(value: unknown): boolean {
  return isCronAgentActionResult(value) && value.notifySuppressed === true;
}

/** 读 notifyWhen 满足轮的一句话原因（完成通知正文用）；非 agent 形状或没有时为 undefined。 */
export function readCronAlertReason(value: unknown): string | undefined {
  if (!isCronAgentActionResult(value)) return undefined;
  const reason = typeof value.alertReason === 'string' ? value.alertReason.trim() : undefined;
  return reason || undefined;
}

/**
 * 成功运行是否「值得打扰」（N-CRON-RESTATE-HUMAN-WHEN / N-CRON-URGENCY-NOTIFY，
 * 原 cronService 内联三元收口至此）：external-watch 或 notifyWhen 任务只认最终
 * 正文里的 <cron_alert> 标记（两者同设时 notifyWhen 语义已是全部）；仅设
 * urgencyCriteria 的任务只认结果显式声明的 can_wait/fyi 头——must_today、
 * 缺头、乱头都算要响（漏一条今日必办比多弹一次代价大）；什么判据都没设的
 * 任务恒有警报（每轮照常通知）。档位声明与 buildCronAgentActionResult 的
 * urgency 解析同源：优先读 <cron_summary> 摘要头部，无摘要块读正文头部。
 */
export function cronAgentRunHasAlert(
  action: { notifyWhen?: string; urgencyCriteria?: string },
  run: { isExternalWatch: boolean; finalAssistantText: string },
): boolean {
  if (run.isExternalWatch || action.notifyWhen?.trim()) {
    return EXTERNAL_WATCH.ALERT_TAG_PATTERN.test(run.finalAssistantText);
  }
  if (action.urgencyCriteria?.trim()) {
    return !declaresCronUrgencyQuiet(
      parseCronRunDigest(run.finalAssistantText).summary ?? run.finalAssistantText,
    );
  }
  return true;
}

/**
 * 组装 agent 动作的执行结果：digest + 紧急档位 + 安静监听轮的 skipped 标记。
 * 档位优先读 `<cron_summary>` 摘要的头部行，没有摘要块时读最后一条 assistant
 * 正文的头部（N-CRON-INBOX-URGENCY-TIER；解析逻辑在 shared/cronUrgency）。
 */
export function buildCronAgentActionResult(
  action: { agentType: string; prompt: string; notifyWhen?: string },
  result: unknown,
  sessionId: string,
  finalAssistantText: string,
  quietWatchRound: boolean,
  notifyQuietRound = false,
): CronAgentActionResult & { skipped?: boolean; reason?: string } {
  const digest = parseCronRunDigest(finalAssistantText);
  const { urgency, raw: urgencyRaw } = parseUrgencyHeader(digest.summary ?? finalAssistantText);
  const alertReason = !notifyQuietRound && action.notifyWhen?.trim()
    ? extractCronAlertText(finalAssistantText)
    : '';
  return {
    agentType: action.agentType,
    prompt: action.prompt,
    result,
    sessionId,
    digest,
    urgency,
    ...(urgencyRaw ? { urgencyRaw } : {}),
    ...(quietWatchRound ? { skipped: true, reason: 'no_new_event' } : {}),
    ...(notifyQuietRound ? { notifySuppressed: true } : {}),
    ...(alertReason ? { alertReason } : {}),
  };
}

export interface CronExecutionRow {
  id: string;
  job_id: string;
  runs_on?: 'local' | 'cloud';
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
  cost_usd?: number | null;
  trigger_json?: string | null;
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

/** cron/heartbeat agent 会话档位：context 带 heartbeatTask 的按 heartbeat 建会话。
 *  （自 cronService 平移，逐字未动——该文件贴 max-lines 线。） */
export function getCronAgentSessionType(action: CronJobAction): 'schedule' | 'heartbeat' {
  if (action.type === 'agent' && action.context?.heartbeatTask) {
    return 'heartbeat';
  }
  return 'schedule';
}

/** cron/heartbeat 会话标题：剥掉历史前缀再按档位重打，避免 [Cron] [Schedule] 叠罗汉。
 *  （自 cronService 平移，逐字未动——该文件贴 max-lines 线。） */
export function formatCronAgentSessionTitle(definition: CronJobDefinition, sessionType: 'schedule' | 'heartbeat'): string {
  const cleanName = definition.name.replace(/^\[(Cron|Schedule|Heartbeat)\]\s*/i, '').trim() || definition.name;
  return sessionType === 'heartbeat'
    ? `[Heartbeat] ${cleanName}`
    : `[Schedule] ${cleanName}`;
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
  return value === 'at' || value === 'every' || value === 'cron' || value === 'event';
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

/**
 * 用户自定义一句话判据（urgencyCriteria N-CRON-MORNING-TRIAGE-URGENCY-RULE /
 * notifyWhen N-CRON-RESTATE-HUMAN-WHEN，同一收口同一上限）：非字符串/空白 → undefined；
 * 超长 → 截断到 CRON_URGENCY_CRITERIA.MAX_CHARS（不拒绝整个 action——它只是
 * 提示词里的一句话修饰，为它毙掉任务归一化会让既存任务突然加载不出来）。
 * 不导出：外部经 normalizeAction 走到这里的归一化。
 */
function normalizeCriteriaSentence(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, CRON_URGENCY_CRITERIA.MAX_CHARS);
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

    case 'event': {
      if (value.source === 'connector') {
        // connector 源（N-TRIGGER-CONNECTOR-MAIL）：目前只有 mail；mailbox 缺省由
        // 轮询器按 DEFAULT_MAILBOX 兜底，这里只收显式非空值。
        if (
          value.connector !== 'mail'
          || value.eventName !== 'message'
          || typeof value.accountId !== 'string'
          || !value.accountId.trim()
        ) {
          return null;
        }
        const mailbox = typeof value.mailbox === 'string' && value.mailbox.trim() ? value.mailbox : undefined;
        return {
          type: 'event',
          source: 'connector',
          connector: 'mail',
          accountId: value.accountId,
          ...(mailbox ? { mailbox } : {}),
          eventName: 'message',
          pollIntervalSec: clampPollIntervalSec(readNumberField(value, 'pollIntervalSec')),
          batchWindowSec: clampBatchWindowSec(readNumberField(value, 'batchWindowSec')),
          minRunIntervalSec: clampMinRunIntervalSec(readNumberField(value, 'minRunIntervalSec')),
        };
      }
      if (
        value.source !== 'channel'
        || value.eventName !== 'message'
        || typeof value.accountId !== 'string'
        || !value.accountId.trim()
      ) {
        return null;
      }
      const chatId = typeof value.chatId === 'string' && value.chatId.trim() ? value.chatId : undefined;
      return {
        type: 'event',
        source: 'channel',
        accountId: value.accountId,
        ...(chatId ? { chatId } : {}),
        eventName: 'message',
        batchWindowSec: clampBatchWindowSec(readNumberField(value, 'batchWindowSec')),
        minRunIntervalSec: clampMinRunIntervalSec(readNumberField(value, 'minRunIntervalSec')),
      };
    }

    default:
      return null;
  }
}

/** 合批窗夹取：[DEFAULT, MAX]，非法/缺省取缺省。 */
function clampBatchWindowSec(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return CRON_EVENT_TRIGGER.DEFAULT_BATCH_WINDOW_SEC;
  }
  return Math.min(value, CRON_EVENT_TRIGGER.MAX_BATCH_WINDOW_SEC);
}

/** 限频间隔夹取：不低于下限（绝不放低），非法/缺省取缺省。 */
function clampMinRunIntervalSec(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return CRON_EVENT_TRIGGER.DEFAULT_MIN_RUN_INTERVAL_SEC;
  }
  return Math.max(value, CRON_EVENT_TRIGGER.MIN_MIN_RUN_INTERVAL_SEC);
}

/** mail 源轮询间隔夹取：不低于下限，非法/缺省取缺省。 */
function clampPollIntervalSec(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return CRON_EVENT_TRIGGER.DEFAULT_POLL_INTERVAL_SEC;
  }
  return Math.max(value, CRON_EVENT_TRIGGER.MIN_POLL_INTERVAL_SEC);
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
        roleId: typeof value.roleId === 'string' ? value.roleId : undefined,
        libraryProjectId:
          typeof value.libraryProjectId === 'string' ? value.libraryProjectId : undefined,
        urgencyCriteria: normalizeCriteriaSentence(value.urgencyCriteria),
        notifyWhen: normalizeCriteriaSentence(value.notifyWhen),
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
        environmentId:
          typeof value.environmentId === 'string' ? value.environmentId : undefined,
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
  const runsOn = row.runs_on === 'cloud' ? 'cloud' : 'local';
  const maxRunBudget = readNumberField(row, 'max_run_budget');
  const maxRuns = readNumberField(row, 'max_runs');
  const resultChannel = readStringField(row, 'result_channel');

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
    runsOn,
    maxRunBudget,
    maxRuns,
    runCount: readNumberField(row, 'run_count') ?? 0,
    resultChannel,
    enabled: row.enabled === 1 || row.enabled === true,
    maxRetries: readOptionalNumberField(row, 'max_retries'),
    // 旧版保存把未设置的 retryDelay 写成 5000（`|| 5000` + schema DEFAULT 5000），
    // 会把退避序列永久钉死在 5s；等于旧默认的存量值视为未设置，走指数退避（R2 审查 Important-2）。
    retryDelay: readOptionalNumberField(row, 'retry_delay') === CRON_GUARDRAILS.LEGACY_DEFAULT_RETRY_DELAY_MS
      ? undefined
      : readOptionalNumberField(row, 'retry_delay'),
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
    runs_on: row.runs_on === 'cloud' ? 'cloud' : 'local',
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
    trigger_json: readNullableStringField(row, 'trigger_json'),
    cost_usd: readNullableNumberField(row, 'cost_usd'),
  };
}

/** trigger_json 列的形状校验：坏行按无 trigger 处理（trigger 是溯源字段，不承重执行语义）。 */
export function parseCronExecutionTrigger(raw: unknown): CronExecutionTrigger | undefined {
  const value = parseJsonValue(raw);
  if (!isRecord(value) || (value.kind !== 'event' && value.kind !== 'schedule')) {
    return undefined;
  }
  const accountId = readStringField(value, 'accountId');
  const source = readStringField(value, 'source');
  const eventCount = readNumberField(value, 'eventCount');
  const droppedCount = readNumberField(value, 'droppedCount');
  const eventIds = Array.isArray(value.eventIds) && value.eventIds.every((id) => typeof id === 'string')
    ? value.eventIds as string[]
    : undefined;
  // 监听标记（N-TRIGGER-GROUP-LISTEN）：只认显式 true，坏值按无标记处理。
  const listen = value.listen === true;
  // connector 源（N-TRIGGER-CONNECTOR-MAIL）：source 'connector' 携带 connector 'mail'。
  const connector = readStringField(value, 'connector');
  return {
    kind: value.kind,
    ...(source === 'channel' || source === 'connector' ? { source } : {}),
    ...(source === 'connector' && connector === 'mail' ? { connector: 'mail' } : {}),
    ...(accountId ? { accountId } : {}),
    ...(eventCount !== undefined ? { eventCount } : {}),
    ...(droppedCount !== undefined ? { droppedCount } : {}),
    ...(eventIds ? { eventIds } : {}),
    ...(listen ? { listen: true } : {}),
  };
}
