import type { CronJobDefinition, CronJobExecution } from '../../shared/contract/cron';

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
  sessionId?: string;
}

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
    case 'ipc':
    case 'memory-consolidation':
    case 'role-wake':
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

export function buildCronApiAddParams(definition: CronJobDefinition): Record<string, unknown> {
  return {
    declarationKey: `${CLOUD_DECLARATION_PREFIX}${definition.id}`,
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
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
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
    sessionId: run.sessionId,
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

  async runJob(remoteJobId: string): Promise<unknown> {
    return this.request('run', 'POST', { id: remoteJobId, mode: 'force' });
  }

  async listRuns(): Promise<CronApiRun[]> {
    return readRunList(await this.request('runs?scope=all', 'GET'));
  }

  start(onRun: (run: CronApiRun) => Promise<void> | void): void {
    if (this.running) return;
    this.running = true;
    void this.runLoop(onRun);
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

  async connectOnce(onRun: (run: CronApiRun) => Promise<void> | void): Promise<void> {
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
          const event = this.parseEventFrame(frame);
          if (event) await onRun(event);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private async runLoop(onRun: (run: CronApiRun) => Promise<void> | void): Promise<void> {
    let delayMs = 500;
    while (this.running) {
      try {
        await this.connectOnce(onRun);
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

  private parseEventFrame(frame: string): CronApiRun | null {
    const lines = frame.split('\n');
    if (!lines.some((line) => line.trim() === 'event: cron')) return null;
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return null;
    try {
      return normalizeRun(JSON.parse(data) as unknown);
    } catch {
      return null;
    }
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
      const detail = typeof envelope.detail === 'string'
        ? envelope.detail
        : envelope.error ?? 'unknown error';
      throw new Error(`Cloud cron API request failed (HTTP ${response.status}): ${detail}`);
    }
    return envelope.result;
  }
}
