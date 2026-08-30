import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  EvalRunEvent,
  EvalRunEventSummary,
  EvalRunRequest,
  EvalRunStartResult,
} from '../../shared/contract/evaluation';
import {
  EVAL_REPEAT_MAX,
  EVAL_RUN_EVENT_SCHEMA_VERSION,
  UNKNOWN_EVAL_RUN_STAMP,
} from '../../shared/contract/evaluation';
import { broadcastToRenderer } from '../platform';
import { EVALUATION_CHANNELS } from '../../shared/ipc/channels';
import { getDatabase, type DatabaseService } from '../services/core/databaseService';
import { resolveSessionDefaultModelConfig } from '../services/core/sessionDefaults';
import { createLogger } from '../services/infra/logger';
import { ExperimentAdapter } from './experimentAdapter';
import { inspectEvalEnvironment, type EvalEnvironmentResult } from './evalEnvironment';
import { parseEvalRunEvent } from './evalRunEventValidation';
import { terminateEvalProcessTree } from './evalProcessTree';
import { resolveProductionShape } from './productionShape';

const logger = createLogger('EvalRunBridge');
const TERMINATE_GRACE_MS = 3_000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1_000;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const TEMP_PREFIX = 'code-agent-eval-';

interface SpawnLike {
  (command: string, args: readonly string[], options: Parameters<typeof spawn>[2]): ChildProcess;
}

interface BridgeDependencies {
  inspectEnvironment(): EvalEnvironmentResult;
  spawnProcess: SpawnLike;
  publish(channel: string, event: unknown): void;
  database(): DatabaseService;
  resolveModel(): ReturnType<typeof resolveSessionDefaultModelConfig>;
  now(): number;
}

interface RunState {
  runId: string;
  request: EvalRunRequest;
  child: ChildProcess;
  pid: number;
  tempRoot: string;
  dataDir: string;
  sandboxRoot: string;
  adapter: ExperimentAdapter;
  buffer: string;
  lastEvent?: EvalRunEvent;
  startEvent?: Extract<EvalRunEvent, { type: 'run_start' }>;
  endEvent?: Extract<EvalRunEvent, { type: 'run_end' }>;
  caseEvents: Array<Extract<EvalRunEvent, { type: 'case_end' }>>;
  failedReason?: string;
  abortReason?: string;
  timeout: ReturnType<typeof setTimeout>;
  terminationPromise?: Promise<void>;
  finishing?: boolean;
  closed: Promise<void>;
  resolveClosed(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item: unknown) => typeof item === 'string' && item.trim() !== '');
}

function validateRequest(value: unknown): EvalRunRequest {
  if (!isRecord(value)) throw new Error('评测请求格式不正确。');
  const forbidden = ['apiKey', 'workingDirectory', 'mock', 'provider', 'model'];
  const foundForbidden = forbidden.filter((key) => key in value);
  if (foundForbidden.length > 0) {
    throw new Error(`评测请求不接受这些字段：${foundForbidden.join(', ')}`);
  }
  const allowed = new Set(['scope', 'maxCases', 'ids', 'tags', 'split', 'timeoutMs', 'repeat']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`评测请求包含未知字段：${unknown.join(', ')}`);
  if (value.scope !== 'smoke' && value.scope !== 'full') throw new Error('scope 必须是 smoke 或 full。');
  if (!Number.isInteger(value.maxCases) || (value.maxCases as number) <= 0) {
    throw new Error('maxCases 必须是正整数。');
  }
  const readStrings = (key: 'ids' | 'tags'): string[] | undefined => {
    const candidate = value[key];
    if (candidate === undefined) return undefined;
    if (!isNonEmptyStringArray(candidate)) {
      throw new Error(`${key} 必须是非空字符串数组。`);
    }
    return candidate.map((item) => item.trim());
  };
  const split = value.split;
  if (split !== undefined && !['held-in', 'held-out', 'control', 'safety'].includes(String(split))) {
    throw new Error('split 值不受支持。');
  }
  const timeoutMs = value.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0)) {
    throw new Error('timeoutMs 必须是正整数。');
  }
  const repeat = value.repeat;
  if (repeat !== undefined && (!Number.isInteger(repeat) || (repeat as number) < 1 || (repeat as number) > EVAL_REPEAT_MAX)) {
    throw new Error(`repeat 必须是 1 到 ${EVAL_REPEAT_MAX} 的整数。`);
  }
  return {
    scope: value.scope,
    maxCases: value.maxCases as number,
    ids: readStrings('ids'),
    tags: readStrings('tags'),
    split: split as EvalRunRequest['split'],
    timeoutMs: timeoutMs as number | undefined,
    repeat: repeat as number | undefined,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function incompleteSummary(state: InternalRunState): EvalRunEventSummary {
  const plannedCaseIds = state.startEvent?.plannedCaseIds ?? state.request.ids ?? [];
  const terminal = state.caseEvents;
  return {
    runId: state.runId,
    startTime: state.startEvent?.ts ?? state.nowStarted,
    endTime: Date.now(),
    duration: Date.now() - (state.startEvent?.ts ?? state.nowStarted),
    total: plannedCaseIds.length || terminal.length,
    passed: terminal.filter((event) => event.status === 'passed').length,
    failed: terminal.filter((event) => event.status === 'failed').length,
    skipped: terminal.filter((event) => event.status === 'skipped').length,
    partial: terminal.filter((event) => event.status === 'partial').length,
    averageScore: terminal.length > 0
      ? terminal.reduce((sum, event) => sum + event.score, 0) / terminal.length
      : 0,
    plannedCaseIds,
    completed: false,
    notRun: Math.max(0, (plannedCaseIds.length || terminal.length) - terminal.length),
    invalidCases: 0,
    failureDistribution: { unknown: 0 },
    aborted: state.abortReason !== undefined,
    abortReason: state.abortReason,
  };
}

type InternalRunState = RunState & { nowStarted: number };

export class EvalRunBridge {
  private readonly runs = new Map<string, InternalRunState>();
  private readonly deps: BridgeDependencies;

  constructor(dependencies: Partial<BridgeDependencies> = {}) {
    this.deps = {
      inspectEnvironment: dependencies.inspectEnvironment ?? (() => inspectEvalEnvironment()),
      spawnProcess: dependencies.spawnProcess ?? spawn,
      publish: dependencies.publish ?? broadcastToRenderer,
      database: dependencies.database ?? getDatabase,
      resolveModel: dependencies.resolveModel ?? resolveSessionDefaultModelConfig,
      now: dependencies.now ?? Date.now,
    };
    this.cleanupOrphans();
  }

  async startRun(rawRequest: unknown): Promise<EvalRunStartResult> {
    const request = validateRequest(rawRequest);
    const environment = this.deps.inspectEnvironment();
    if (!environment.available || !environment.repositoryRoot || !environment.entryPath || !environment.tsxPath) {
      throw new Error(environment.message);
    }

    const db = this.deps.database();
    if (!db.isReady) await db.initialize();
    const model = this.deps.resolveModel();
    if (!model.apiKey) throw new Error('当前默认模型没有可用密钥，无法开始评测。');

    const runId = randomUUID();
    logger.info('Resolved production shape for eval comparison', {
      runId,
      productionShape: resolveProductionShape(model.model),
    });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    const dataDir = path.join(tempRoot, 'data');
    const sandboxRoot = path.join(tempRoot, 'sandboxes');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(sandboxRoot, { recursive: true });
    const policyPath = path.join(environment.repositoryRoot, '.claude', 'eval-approval-policy.json');
    const args = [
      environment.tsxPath,
      environment.entryPath,
      '--real',
      '--json-events',
      '--data-dir', dataDir,
      '--run-id', runId,
      '--scope', request.scope,
      '--max-cases', String(request.maxCases),
      ...(request.repeat !== undefined ? ['--repeat', String(request.repeat)] : []),
      ...(request.ids?.length ? ['--ids', request.ids.join(',')] : []),
      ...(request.tags?.length ? ['--tags', request.tags.join(',')] : []),
      ...(request.split ? ['--split', request.split] : []),
    ];
    let child: ChildProcess;
    try {
      child = this.deps.spawnProcess(environment.nodePath, args, {
        cwd: environment.repositoryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: {
          ...process.env,
          AUTO_TEST_PROVIDER: model.provider,
          AUTO_TEST_MODEL: model.model,
          AUTO_TEST_API_KEY: model.apiKey,
          ...(model.baseUrl ? { AUTO_TEST_BASE_URL: model.baseUrl } : {}),
          NEO_SCRIPTED_APPROVAL_POLICY: policyPath,
          CODE_AGENT_EVAL_BRIDGE: '1',
          CODE_AGENT_EVAL_TEMP_ROOT: sandboxRoot,
          OS_SANDBOX_ENABLED: 'true',
          CODE_AGENT_CLI_MODE: '',
        },
      });
    } catch (error) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      throw new Error('评测进程没有成功启动。', { cause: error });
    }
    if (!child.pid || !child.stdout || !child.stderr) {
      child.kill('SIGTERM');
      fs.rmSync(tempRoot, { recursive: true, force: true });
      throw new Error('评测进程没有成功启动。');
    }

    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const state: InternalRunState = {
      runId,
      request,
      child,
      pid: child.pid,
      tempRoot,
      dataDir,
      sandboxRoot,
      adapter: new ExperimentAdapter(db),
      buffer: '',
      caseEvents: [],
      timeout: setTimeout(() => {
        void this.abortRun(runId, '评测超过总时限，已停止。');
      }, request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS),
      closed,
      resolveClosed,
      nowStarted: this.deps.now(),
    };
    this.runs.set(runId, state);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(state, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) logger.info('eval child stderr', { runId, line });
    });
    child.once('error', (error) => {
      this.failRun(state, `评测进程启动失败：${error.message}`);
    });
    child.once('close', (code, signal) => {
      void this.finishClosedRun(state, code, signal);
    });
    return { runId };
  }

  subscribe(runId: string): { runId: string; running: boolean } {
    return { runId, running: this.runs.has(runId) };
  }

  async abortRun(runId: string, reason = '评测已由管理员停止。'): Promise<{ runId: string; pid: number; terminated: boolean }> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`找不到正在运行的评测：${runId}`);
    state.abortReason = reason;
    void this.requestTermination(state);
    await state.closed;
    const terminated = !isProcessAlive(state.pid) && !isProcessGroupAlive(state.pid);
    if (!terminated) throw new Error(`评测进程 ${state.pid} 未能停止。`);
    return { runId, pid: state.pid, terminated };
  }

  private consumeStdout(state: InternalRunState, chunk: string): void {
    state.buffer += chunk;
    for (;;) {
      const newline = state.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      if (line) this.consumeLine(state, line);
    }
  }

  private consumeLine(state: InternalRunState, line: string): void {
    if (state.failedReason) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.failRun(state, `评测事件无法解析：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let event: EvalRunEvent;
    try {
      event = parseEvalRunEvent(parsed);
    } catch (error) {
      this.failRun(state, error instanceof Error ? error.message : String(error));
      return;
    }
    if (event.runId !== state.runId) {
      this.failRun(state, '评测事件的运行编号不一致。');
      return;
    }
    if (state.endEvent) {
      this.failRun(state, '评测结束后仍收到事件。');
      return;
    }
    if (event.type === 'run_start' && state.startEvent) {
      this.failRun(state, '评测开始事件重复。');
      return;
    }
    if (!['run_start', 'error', 'run_end'].includes(event.type) && !state.startEvent) {
      this.failRun(state, '评测开始事件缺失。');
      return;
    }
    if (event.type === 'run_end' && event.summary.runId !== state.runId) {
      this.failRun(state, '评测汇总的运行编号不一致。');
      return;
    }
    state.lastEvent = event;
    try {
      if (event.type === 'run_start') {
        if (event.config.mode !== 'real') throw new Error('评测桥只允许真实运行。');
        state.startEvent = event;
        state.adapter.beginEventRun(event);
      } else if (event.type === 'memory_injected') {
        state.adapter.recordMemoryInjection(event);
      } else if (event.type === 'case_end') {
        state.caseEvents.push(event);
        state.adapter.persistEventCase(event);
      } else if (event.type === 'run_end') {
        state.endEvent = event;
        state.adapter.finishEventRun(state.runId, event.summary);
      }
      this.deps.publish(EVALUATION_CHANNELS.RUN_EVENTS, event);
    } catch (error) {
      this.failRun(state, error instanceof Error ? error.message : String(error));
    }
  }

  private failRun(state: InternalRunState, reason: string): void {
    if (state.failedReason) return;
    state.failedReason = reason;
    const event: EvalRunEvent = {
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type: 'error',
      ts: this.deps.now(),
      runId: state.runId,
      error: reason,
    };
    state.lastEvent = event;
    this.deps.publish(EVALUATION_CHANNELS.RUN_EVENTS, event);
    void this.requestTermination(state);
  }

  private requestTermination(state: InternalRunState): Promise<void> {
    state.terminationPromise ??= terminateEvalProcessTree(state.child, TERMINATE_GRACE_MS)
      .catch((error) => {
        logger.warn('Failed to terminate eval process tree', {
          runId: state.runId,
          pid: state.pid,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return state.terminationPromise;
  }

  private async finishClosedRun(
    state: InternalRunState,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (state.finishing) return;
    state.finishing = true;
    clearTimeout(state.timeout);
    if (state.buffer.trim()) this.consumeLine(state, state.buffer.trim());
    if (state.terminationPromise || isProcessGroupAlive(state.pid)) {
      await this.requestTermination(state);
    }
    const treeTerminated = !isProcessAlive(state.pid) && !isProcessGroupAlive(state.pid);
    const cleanEnd = treeTerminated
      && code === 0
      && state.lastEvent?.type === 'run_end'
      && state.endEvent?.exitCode === 0;
    if (!cleanEnd && !state.failedReason) {
      this.failRun(state, state.abortReason ?? (treeTerminated
        ? `评测异常结束（code=${code ?? 'null'}, signal=${signal ?? 'none'}）。`
        : `评测进程树 ${state.pid} 未能停止。`));
    }
    if (!cleanEnd) {
      if (!state.startEvent) {
        const syntheticStart: Extract<EvalRunEvent, { type: 'run_start' }> = {
          schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
          type: 'run_start',
          ts: state.nowStarted,
          runId: state.runId,
          plannedCaseIds: state.request.ids ?? [],
          config: {
            ...UNKNOWN_EVAL_RUN_STAMP,
            mode: 'real',
            model: 'unknown',
            provider: 'unknown',
            scope: state.request.scope,
            maxCases: state.request.maxCases,
            concurrency: 1,
            gitCommit: 'unknown',
            testCaseDir: 'unknown',
          },
        };
        state.adapter.beginEventRun(syntheticStart);
      }
      state.adapter.finishEventRun(state.runId, incompleteSummary(state), state.failedReason ?? state.abortReason);
    }
    if (treeTerminated) fs.rmSync(state.tempRoot, { recursive: true, force: true });
    this.runs.delete(state.runId);
    state.resolveClosed();
  }

  private cleanupOrphans(): void {
    const cutoff = this.deps.now() - ORPHAN_MAX_AGE_MS;
    for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
      const target = path.join(os.tmpdir(), entry.name);
      try {
        if (fs.statSync(target).mtimeMs < cutoff) fs.rmSync(target, { recursive: true, force: true });
      } catch (error) {
        logger.warn('Failed to clean orphan eval directory', {
          target,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

let bridge: EvalRunBridge | undefined;

export function getEvalRunBridge(): EvalRunBridge {
  bridge ??= new EvalRunBridge();
  return bridge;
}
