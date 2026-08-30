// ============================================================================
// Status File Writer - `--status-file` 运行态心跳
//
// 为 headless 编排器（外部脚本/调度系统轮询）提供单文件 JSON 状态快照：
// - run 进行中按固定间隔（默认 2s）节流写快照，不跟随事件流逐条写；
// - 原子写：先写同目录 tmp 文件再 rename，轮询方永远读不到半截 JSON；
// - 结束时写终态（status success|error + 错误信息 + MetricsCollector 汇总）；
// - 任何写入失败只降级（停用 writer），绝不影响 run 本身。
// ============================================================================

import fs from 'fs';
import path from 'path';
import type { SessionMetrics } from '../../host/agent/metricsCollector';
import { createLogger } from '../../host/services/infra/logger';

const logger = createLogger('CLI-StatusFile');

/** 状态文件格式版本；schema 变更需递增，外部编排器按此字段解析（勿导出：knip production ratchet） */
const STATUS_FILE_VERSION = 1;

export type StatusFilePhase = 'starting' | 'running' | 'finished';

export interface StatusFileSnapshot {
  version: typeof STATUS_FILE_VERSION;
  phase: StatusFilePhase;
  sessionId: string;
  pid: number;
  /** run 开始时间（epoch ms） */
  startedAt: number;
  /** 本快照写入时间（epoch ms） */
  updatedAt: number;
  /** 已耗时（秒，一位小数） */
  elapsedSeconds: number;
  /** 当前轮次（turn_start 计数；尚未进入首轮为 0） */
  turn: number;
  tokens: { input: number; output: number };
  /** 最近一次启动的工具调用 */
  lastTool: { name: string; ts: number } | null;
  /** 终态（phase = finished 时必有） */
  status?: 'success' | 'error';
  /** 失败详情（status = error 时必有） */
  error?: { message: string; class?: string };
  /** 终态指标汇总（复用 MetricsCollector 数据） */
  metrics?: SessionMetrics;
}

export interface StatusFileFinish {
  success: boolean;
  error?: { message: string; class?: string };
  metrics?: SessionMetrics;
}

export class StatusFileWriter {
  private readonly filePath: string;
  private readonly tmpPath: string;
  private readonly sessionId: string;
  private readonly startedAt: number;
  private readonly intervalMs: number;
  /** 每次写快照时拉取最新 token 用量（如 MetricsCollector 实时计数）；缺省用 setTokens 累计值 */
  private readonly tokensProvider?: () => { input: number; output: number };
  private timer: ReturnType<typeof setInterval> | null = null;
  private disabled = false;

  private phase: StatusFilePhase = 'starting';
  private turn = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private lastTool: { name: string; ts: number } | null = null;

  constructor(
    filePath: string,
    sessionId: string,
    options: { intervalMs?: number; startedAt?: number; tokensProvider?: () => { input: number; output: number } } = {},
  ) {
    this.filePath = path.resolve(filePath);
    this.tmpPath = `${this.filePath}.${process.pid}.tmp`;
    this.sessionId = sessionId;
    this.startedAt = options.startedAt ?? Date.now();
    this.intervalMs = options.intervalMs ?? 2000;
    this.tokensProvider = options.tokensProvider;
  }

  /**
   * 写入初始（starting）快照并启动节流 ticker。
   * ticker unref：writer 不会阻止进程退出。
   */
  start(): void {
    if (!this.writeSnapshot()) return;
    this.timer = setInterval(() => {
      this.writeSnapshot();
    }, this.intervalMs);
    this.timer.unref();
  }

  /** 首个 agent 事件到达时由 starting 转为 running */
  markRunning(): void {
    if (this.phase === 'starting') {
      this.phase = 'running';
    }
  }

  onTurnStart(): void {
    this.turn += 1;
  }

  onToolStart(name: string): void {
    this.lastTool = { name, ts: Date.now() };
  }

  setTokens(inputTokens: number, outputTokens: number): void {
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
  }

  /** 写终态快照并停止 ticker */
  finish(result: StatusFileFinish): void {
    if (this.disabled) return;
    this.phase = 'finished';
    this.stopTimer();
    this.writeSnapshot(result);
  }

  /** 仅停止 ticker（不写文件） */
  stop(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private buildSnapshot(finish?: StatusFileFinish): StatusFileSnapshot {
    const liveTokens = this.tokensProvider?.();
    const snapshot: StatusFileSnapshot = {
      version: STATUS_FILE_VERSION,
      phase: this.phase,
      sessionId: this.sessionId,
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      elapsedSeconds: Math.round((Date.now() - this.startedAt) / 100) / 10,
      turn: this.turn,
      tokens: liveTokens ?? { input: this.inputTokens, output: this.outputTokens },
      lastTool: this.lastTool,
    };
    if (finish) {
      snapshot.status = finish.success ? 'success' : 'error';
      if (!finish.success && finish.error) {
        snapshot.error = finish.error;
      }
      if (finish.metrics) {
        snapshot.metrics = finish.metrics;
      }
    }
    return snapshot;
  }

  /**
   * 原子写：tmp + rename（同目录，rename 在 POSIX/Windows 上均原子）。
   * 返回是否仍处于激活状态；失败一次即永久停用，避免反复打到坏路径上。
   */
  private writeSnapshot(finish?: StatusFileFinish): boolean {
    if (this.disabled) return false;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.tmpPath, JSON.stringify(this.buildSnapshot(finish), null, 2), 'utf-8');
      fs.renameSync(this.tmpPath, this.filePath);
      return true;
    } catch (error) {
      this.disabled = true;
      this.stopTimer();
      logger.warn('Status file write failed; disabling writer', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
