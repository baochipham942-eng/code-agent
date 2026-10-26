import type { CronJobDefinition, CronJobExecution } from '../../shared/contract/cron';
import { ROLE_PROACTIVITY } from '../../shared/constants/memory';
import { isExternalSideEffectTool } from '../tools/externalSideEffect';
import { validateRoleWakeCloudPayload } from './roleWakeCloudPayload';

export interface CronApiConfig {
  baseUrl: string;
  token: string;
}

export interface CronApiRun {
  jobId: string;
  action: 'started' | 'finished';
  ts: number;
  runId?: string;
  runAtMs?: number;
  durationMs?: number;
  status?: 'ok' | 'error' | 'skipped';
  error?: string;
  summary?: string;
}

/** register/rotate 的一次性回执：token 只在这里出现，调用方展示一次后即丢弃。 */
export interface CronApiHookSecret {
  /** 可粘贴进外部系统 webhook URL 字段的完整 hook URL（已含 ?token=）。 */
  url: string;
  /** hook token；中继只存哈希，rotate 后旧 token 立即失效。 */
  token: string;
}

/**
 * webhook 中继帧（N-CRON-WEBHOOK-CLOUD-HOOK）：投递（event: cron_hook）与
 * 过期通告（event: cron_hook_expired）。wire 契约见 docs/architecture/cron-webhook-relay.md。
 */
export type CronApiHookEvent =
  | {
    type: 'hook';
    jobId: string;
    deliveryId: string;
    receivedAt: number;
    body: string;
  }
  | {
    type: 'hook-expired';
    jobId: string;
    count: number;
  };

type CronApiEnvelope = {
  ok?: boolean;
  result?: unknown;
  error?: string;
  detail?: unknown;
};

type CronApiFetch = typeof fetch;

const CLOUD_DECLARATION_PREFIX = 'neo:';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function scheduleToCronApi(definition: CronJobDefinition): Record<string, unknown> {
  const schedule = definition.schedule;
  if (schedule.type === 'event') {
    // 创建护栏已把 event 任务钉在 runsOn 'local'；走到这里说明不变量被打破，拒绝声明到云端。
    throw new Error("Event-triggered jobs cannot be declared to the cloud scheduler; they require runsOn 'local'.");
  }
  if (schedule.type === 'at') {
    const at = typeof schedule.datetime === 'number'
      ? new Date(schedule.datetime).toISOString()
      : schedule.datetime;
    return { kind: 'at', at };
  }
  if (schedule.type === 'every') {
    const unitMs = {
      seconds: 1_000,
      minutes: 60_000,
      hours: 3_600_000,
      days: 86_400_000,
    }[schedule.unit];
    const startAt = schedule.startAt == null
      ? undefined
      : typeof schedule.startAt === 'number'
        ? schedule.startAt
        : Date.parse(schedule.startAt);
    return {
      kind: 'every',
      everyMs: schedule.interval * unitMs,
      ...(Number.isFinite(startAt) ? { anchorMs: startAt } : {}),
    };
  }
  return {
    kind: 'cron',
    expr: schedule.expression,
    ...(schedule.timezone ? { tz: schedule.timezone } : {}),
  };
}

function actionToCronApiPayload(definition: CronJobDefinition): Record<string, unknown> {
  const action = definition.action;
  const timeoutSeconds = definition.timeout == null
    ? undefined
    : Math.max(0, definition.timeout / 1_000);

  switch (action.type) {
    case 'agent':
      return {
        kind: 'agentTurn',
        message: action.prompt,
        ...(timeoutSeconds == null ? {} : { timeoutSeconds }),
      };
    case 'shell':
      return {
        kind: 'command',
        argv: ['/bin/sh', '-lc', action.command],
        ...(action.cwd ? { cwd: action.cwd } : {}),
        ...(action.env ? { env: action.env } : {}),
        ...(timeoutSeconds == null ? {} : { timeoutSeconds }),
      };
    case 'webhook': {
      const argv = ['curl', '--fail-with-body', '--silent', '--show-error', '--request', action.method];
      for (const [name, value] of Object.entries(action.headers ?? {})) {
        argv.push('--header', `${name}: ${value}`);
      }
      if (action.body !== undefined) {
        argv.push(
          '--header',
          'Content-Type: application/json',
          '--data-binary',
          JSON.stringify(action.body),
        );
      }
      argv.push(action.url);
      return {
        kind: 'command',
        argv,
        ...(timeoutSeconds == null ? {} : { timeoutSeconds }),
      };
    }
    case 'tool':
      return {
        kind: 'agentTurn',
        message: [
          `Call the ${action.toolName} tool exactly once with these JSON arguments:`,
          JSON.stringify(action.parameters),
          'Return the tool result.',
        ].join('\n'),
        ...(timeoutSeconds == null ? {} : { timeoutSeconds }),
      };
    case 'role-wake': {
      // 云端未接线：先用 draft 校验器钉住协议形状，把拒因带进错误消息；
      // 校验通过也照样拒绝发射 payload。工具面由 resolveWakeRunToolScope 异步解析，
      // 云端声明路径落地前先按空面校验；只读判定沿用醒来链路同款
      // isExternalSideEffectTool 口径（resolveWakeRunToolScope 丢对外副作用工具的判据）。
      const validation = validateRoleWakeCloudPayload({
        roleId: action.roleId,
        environmentId: action.environmentId,
        readOnlyToolScope: [],
        maxWakesPerDay: ROLE_PROACTIVITY.MAX_WAKES_PER_DAY,
        isToolReadOnly: (toolName) => !isExternalSideEffectTool(toolName),
      });
      if (!validation.ok) {
        throw new Error(
          `Cloud cron does not support the role-wake action type: ${validation.reason}`
          + (validation.toolName ? ` (${validation.toolName})` : '') + '.',
        );
      }
      throw new Error('Cloud cron does not support the role-wake action type: not wired yet.');
    }
    case 'ipc':
    case 'memory-consolidation':
      throw new Error(`Cloud cron does not support the ${action.type} action type.`);
  }
}

function cronApiMutableFields(definition: CronJobDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    enabled: definition.enabled,
    schedule: scheduleToCronApi(definition),
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: actionToCronApiPayload(definition),
    delivery: { mode: 'none' },
  };
}

export function cloudDeclarationKey(localJobId: string): string {
  return `${CLOUD_DECLARATION_PREFIX}${localJobId}`;
}

export function buildCronApiAddParams(definition: CronJobDefinition): Record<string, unknown> {
  return {
    declarationKey: cloudDeclarationKey(definition.id),
    ...cronApiMutableFields(definition),
  };
}

export function buildCronApiUpdateParams(
  definition: CronJobDefinition,
  remoteJobId: string,
): Record<string, unknown> {
  return { id: remoteJobId, patch: cronApiMutableFields(definition) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRemoteJobId(result: unknown): string {
  if (isRecord(result) && typeof result.id === 'string') return result.id;
  if (isRecord(result) && isRecord(result.job) && typeof result.job.id === 'string') {
    return result.job.id;
  }
  throw new Error('Cloud cron API returned an invalid job response.');
}

function normalizeRun(value: unknown): CronApiRun | null {
  if (!isRecord(value) || typeof value.jobId !== 'string') return null;
  const action = value.action;
  if (action !== 'started' && action !== 'finished') return null;
  const ts = typeof value.ts === 'number'
    ? value.ts
    : typeof value.runAtMs === 'number'
      ? value.runAtMs
      : Date.now();
  return {
    jobId: value.jobId,
    action,
    ts,
    runId: typeof value.runId === 'string' ? value.runId : undefined,
    runAtMs: typeof value.runAtMs === 'number' ? value.runAtMs : undefined,
    durationMs: typeof value.durationMs === 'number' ? value.durationMs : undefined,
    status: value.status === 'ok' || value.status === 'error' || value.status === 'skipped'
      ? value.status
      : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
    summary: typeof value.summary === 'string' ? value.summary : undefined,
  };
}

function readRunList(result: unknown): CronApiRun[] {
  const values = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.entries)
      ? result.entries
      : isRecord(result) && Array.isArray(result.runs)
        ? result.runs
        : [];
  return values.map(normalizeRun).filter((run): run is CronApiRun => run !== null);
}

/** cron_hook 帧的形状校验：缺 jobId/deliveryId/body 的坏帧丢弃（不喂给触发链路）。 */
function normalizeHookDelivery(value: unknown): Extract<CronApiHookEvent, { type: 'hook' }> | null {
  if (!isRecord(value) || typeof value.jobId !== 'string' || typeof value.deliveryId !== 'string') return null;
  if (typeof value.body !== 'string') return null;
  return {
    type: 'hook',
    jobId: value.jobId,
    deliveryId: value.deliveryId,
    // receivedAt 缺失时按到达时刻兜底（与 normalizeRun 对 ts 的口径一致）。
    receivedAt: typeof value.receivedAt === 'number' && Number.isFinite(value.receivedAt) ? value.receivedAt : Date.now(),
    body: value.body,
  };
}

/** cron_hook_expired 帧的形状校验：count 非有限数按 0 处理（通告性帧，不因坏值丢弃）。 */
function normalizeHookExpiry(value: unknown): Extract<CronApiHookEvent, { type: 'hook-expired' }> | null {
  if (!isRecord(value) || typeof value.jobId !== 'string') return null;
  return {
    type: 'hook-expired',
    jobId: value.jobId,
    count: typeof value.count === 'number' && Number.isFinite(value.count) ? value.count : 0,
  };
}

/** register/rotate 的 result 形状校验：url/token 必须都是非空字符串。 */
function readHookSecret(result: unknown): CronApiHookSecret {
  if (isRecord(result) && typeof result.url === 'string' && result.url && typeof result.token === 'string' && result.token) {
    return { url: result.url, token: result.token };
  }
  throw new Error('Cloud cron hook registration returned an invalid response.');
}

function toExecutionStatus(run: CronApiRun): CronJobExecution['status'] {
  if (run.action === 'started') return 'running';
  return run.status === 'error' ? 'failed' : 'completed';
}

export function cloudRunToExecution(run: CronApiRun, localJobId: string): CronJobExecution {
  const startedAt = run.runAtMs ?? run.ts;
  const completedAt = run.action === 'finished'
    ? startedAt + (run.durationMs ?? 0)
    : undefined;
  return {
    id: `cloud:${run.runId ?? `${run.jobId}:${startedAt}`}`,
    jobId: localJobId,
    runsOn: 'cloud',
    // 🚫 不带 sessionId：云端 run 的 session 活在服务端，本地 sessions 表里没有这一行，
    // 而 cron_executions.session_id 是指向 sessions(id) 的外键——照抄进来会让整行
    // INSERT 撞 SQLITE_CONSTRAINT_FOREIGNKEY，执行记录永远停在「运行中」（2026-08-24
    // 端到端真机验收实付）。UI 侧的「打开会话」也只能切本地会话，对云端 run 本就是死链。
    status: toExecutionStatus(run),
    scheduledAt: startedAt,
    startedAt,
    completedAt,
    duration: run.durationMs,
    result: run.summary == null ? undefined : { summary: run.summary },
    error: run.error,
    retryAttempt: 0,
  };
}

export class CronApiClient {
  private running = false;
  private activeController?: AbortController;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectResolve?: () => void;

  constructor(
    private readonly getConfig: () => CronApiConfig | undefined,
    private readonly fetchImpl: CronApiFetch = fetch,
  ) {}

  isConfigured(): boolean {
    const config = this.getConfig();
    return Boolean(config?.baseUrl.trim() && config.token.trim());
  }

  async addJob(params: Record<string, unknown>): Promise<string> {
    return readRemoteJobId(await this.request('add', 'POST', params));
  }

  async updateJob(params: Record<string, unknown>): Promise<void> {
    await this.request('update', 'POST', params);
  }

  async removeJob(remoteJobId: string): Promise<void> {
    await this.request('remove', 'POST', { id: remoteJobId });
  }

  /** 云端现存任务的 id 与 declarationKey，用来判断某条是否还在（不靠报错文案）。 */
  async listJobs(): Promise<Array<{ id: string; declarationKey?: string }>> {
    const result = await this.request('list', 'GET');
    const jobs = isRecord(result) && Array.isArray(result.jobs) ? result.jobs : [];
    return jobs.filter(isRecord).flatMap((job) => (typeof job.id === 'string'
      ? [{
        id: job.id,
        declarationKey: typeof job.declarationKey === 'string' ? job.declarationKey : undefined,
      }]
      : []));
  }

  async runJob(remoteJobId: string): Promise<unknown> {
    return this.request('run', 'POST', { id: remoteJobId, mode: 'force' });
  }

  async listRuns(): Promise<CronApiRun[]> {
    return readRunList(await this.request('runs?scope=all', 'GET'));
  }

  /**
   * webhook 中继端点（N-CRON-WEBHOOK-CLOUD-HOOK；wire 契约见
   * docs/architecture/cron-webhook-relay.md）。全部走既有 cloud Bearer；
   * 失败统一包一层可区分的 hook 前缀（含底层 HTTP 状态），不与普通 cron API
   * 报错混淆。register/rotate 的 {url, token} 只作为返回值出现，绝不落日志。
   */
  async registerHook(jobId: string): Promise<CronApiHookSecret> {
    return readHookSecret(await this.hookRequest('register', { jobId }));
  }

  async rotateHook(jobId: string): Promise<CronApiHookSecret> {
    return readHookSecret(await this.hookRequest('rotate', { jobId }));
  }

  async removeHook(jobId: string): Promise<void> {
    await this.hookRequest('remove', { jobId });
  }

  /** at-least-once 的确认侧：投递已被终态处置（入队/去重/忽略）后逐批回执。 */
  async ackHooks(jobId: string, deliveryIds: readonly string[]): Promise<void> {
    await this.hookRequest('ack', { jobId, deliveryIds });
  }

  private async hookRequest(operation: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.request(`hooks/${operation}`, 'POST', params);
    } catch (error) {
      throw new Error(
        `Cloud cron hook ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  start(
    onRun: (run: CronApiRun) => Promise<void> | void,
    onHook?: (event: CronApiHookEvent) => Promise<void> | void,
  ): void {
    if (this.running) return;
    this.running = true;
    void this.runLoop(onRun, onHook);
  }

  stop(): void {
    this.running = false;
    this.activeController?.abort();
    this.activeController = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectResolve?.();
    this.reconnectTimer = undefined;
    this.reconnectResolve = undefined;
  }

  async connectOnce(
    onRun: (run: CronApiRun) => Promise<void> | void,
    onHook?: (event: CronApiHookEvent) => Promise<void> | void,
  ): Promise<void> {
    const missedRuns = await this.listRuns();
    for (const run of missedRuns) await onRun(run);

    const { baseUrl, token } = this.requireConfig();
    const controller = new AbortController();
    this.activeController = controller;
    let response: Response;
    try {
      response = await this.fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/cron/events`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error('Cloud cron event stream is unavailable.', { cause: error });
    }
    if (!response.ok || !response.body) {
      throw new Error(`Cloud cron event stream failed with HTTP ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = this.parseStreamFrame(frame);
          if (event !== null) {
            // 帧分发按形状判别：run 帧（action 字段）走 onRun，hook 帧走可选的 onHook。
            if ('action' in event) await onRun(event);
            else if (onHook) await onHook(event);
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private async runLoop(
    onRun: (run: CronApiRun) => Promise<void> | void,
    onHook?: (event: CronApiHookEvent) => Promise<void> | void,
  ): Promise<void> {
    let delayMs = 500;
    while (this.running) {
      try {
        await this.connectOnce(onRun, onHook);
        delayMs = 500;
      } catch (error) {
        if (!this.running) return;
        console.warn('[CronApiClient] Cloud cron stream disconnected:', error instanceof Error ? error.message : String(error));
      }
      if (!this.running) return;
      await new Promise<void>((resolve) => {
        this.reconnectResolve = resolve;
        this.reconnectTimer = setTimeout(resolve, delayMs);
      });
      this.reconnectTimer = undefined;
      this.reconnectResolve = undefined;
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }

  /**
   * 单帧解析：`event: cron`（run）与 `event: cron_hook` / `event: cron_hook_expired`
   * （webhook 中继，N-CRON-WEBHOOK-CLOUD-HOOK）。与旧 parseEventFrame 同口径：
   * 没有 `event: cron` 行的帧仍然丢弃（不把无 event 行的帧当 cron）。
   */
  private parseStreamFrame(frame: string): CronApiRun | CronApiHookEvent | null {
    const lines = frame.split('\n');
    const eventName = lines
      .map((line) => /^event:\s*(.*)$/.exec(line)?.[1]?.trim())
      .find((name): name is string => name !== undefined);
    if (eventName !== 'cron' && eventName !== 'cron_hook' && eventName !== 'cron_hook_expired') {
      return null;
    }
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return null;
    }
    if (eventName === 'cron_hook') return normalizeHookDelivery(parsed);
    if (eventName === 'cron_hook_expired') return normalizeHookExpiry(parsed);
    return normalizeRun(parsed);
  }

  private requireConfig(): CronApiConfig {
    const config = this.getConfig();
    if (!config?.baseUrl.trim() || !config.token.trim()) {
      throw new Error('Cloud cron API is not configured.');
    }
    return config;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const { baseUrl, token } = this.requireConfig();
    let response: Response;
    try {
      response = await this.fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/cron/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(params ?? {}) } : {}),
      });
    } catch (error) {
      throw new Error('Cloud cron API is unavailable.', { cause: error });
    }

    let envelope: CronApiEnvelope;
    try {
      envelope = await response.json() as CronApiEnvelope;
    } catch (error) {
      throw new Error(`Cloud cron API returned invalid JSON (HTTP ${response.status}).`, { cause: error });
    }
    if (!response.ok || envelope.ok !== true) {
      // 别把 detail 对象整个丢掉：gateway 的真实原因（code / message）都在里面，
      // 只留一句 "gateway_error" 会让无人值守场景失去唯一的排查线索。
      const detail = typeof envelope.detail === 'string'
        ? envelope.detail
        : envelope.detail === undefined
          ? envelope.error ?? 'unknown error'
          : `${envelope.error ?? 'error'}: ${JSON.stringify(envelope.detail)}`;
      throw new Error(`Cloud cron API request failed (HTTP ${response.status}): ${detail}`);
    }
    return envelope.result;
  }
}
