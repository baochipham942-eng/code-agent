// ============================================================================
// FileSwarmTraceRepository — Swarm 运行/agent/事件 JSONL 持久化（Pi 借鉴）
// ============================================================================
//
// 与 SwarmTraceRepository (SQLite) 同 API，把每次 run 存成单文件 jsonl：
//   <storageDir>/<YYYY-MM-DDTHHmmss>__<runId>.jsonl
//
// Entry 类型：run_started / agent_upserted / event / run_closed。
// 写入由外层 SwarmTraceWriter 已经串行化（pendingPersist Promise 链）+
// 单 in-process active run 假设保证；本 repo 内部不加锁、不开异步。
//
// 读取通过对 jsonl 逐行 parse + 内存回放还原 SwarmRunRecord/agents/events。
// listRuns 走目录扫描，不维护单独 index 文件（与 Pi 一致）。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { SWARM_TRACE } from '../../../../shared/constants/storage';
import { createLogger } from '../../infra/logger';
import type {
  SwarmRunRecord,
  SwarmRunAgentRecord,
  SwarmRunEventRecord,
  SwarmRunListItem,
  SwarmRunDetail,
  SwarmRunStatus,
  SwarmRunCoordinator,
  SwarmRunTrigger,
  SwarmEventLevel,
} from '../../../../shared/contract/swarmTrace';

const logger = createLogger('FileSwarmTraceRepository');

// ============================================================================
// 写入入参（结构跟 SwarmTraceRepository 完全一致，Phase 2 抽到共享 contract）
// ============================================================================

export interface StartRunInput {
  id: string;
  sessionId: string | null;
  coordinator: SwarmRunCoordinator;
  startedAt: number;
  totalAgents: number;
  trigger: SwarmRunTrigger;
}

export interface CloseRunInput {
  id: string;
  status: SwarmRunStatus;
  endedAt: number;
  completedCount: number;
  failedCount: number;
  parallelPeak: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalToolCalls: number;
  totalCostUsd: number;
  errorSummary: string | null;
  aggregation: SwarmRunRecord['aggregation'];
}

export interface UpsertAgentInput {
  runId: string;
  agentId: string;
  name: string;
  role: string;
  status: SwarmRunAgentRecord['status'];
  startTime: number | null;
  endTime: number | null;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  costUsd: number;
  error: string | null;
  failureCategory: string | null;
  filesChanged: string[];
}

export interface AppendEventInput {
  runId: string;
  seq: number;
  timestamp: number;
  eventType: string;
  agentId: string | null;
  level: SwarmEventLevel;
  title: string;
  summary: string;
  payload: unknown;
}

// ============================================================================
// JSONL Entry 类型（internal）
// ============================================================================

interface RunStartedEntry {
  type: 'run_started';
  runId: string;
  sessionId: string | null;
  coordinator: SwarmRunCoordinator;
  startedAt: number;
  totalAgents: number;
  trigger: SwarmRunTrigger;
}

interface AgentUpsertedEntry {
  type: 'agent_upserted';
  agentId: string;
  name: string;
  role: string;
  status: SwarmRunAgentRecord['status'];
  startTime: number | null;
  endTime: number | null;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  costUsd: number;
  error: string | null;
  failureCategory: string | null;
  filesChanged: string[];
}

interface EventEntry {
  type: 'event';
  seq: number;
  ts: number;
  eventType: string;
  agentId: string | null;
  level: SwarmEventLevel;
  title: string;
  summary: string;
  payload: unknown;
}

interface RunClosedEntry {
  type: 'run_closed';
  status: SwarmRunStatus;
  endedAt: number;
  completedCount: number;
  failedCount: number;
  parallelPeak: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalToolCalls: number;
  totalCostUsd: number;
  errorSummary: string | null;
  aggregation: SwarmRunRecord['aggregation'];
}

type SwarmRunEntry = RunStartedEntry | AgentUpsertedEntry | EventEntry | RunClosedEntry;

// ============================================================================
// Helpers
// ============================================================================

/** 与 SwarmTraceRepository.clampPayloadJson 同语义，但返回对象（jsonl 友好） */
function clampPayload(payload: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(payload ?? null);
  } catch {
    return null;
  }
  if (json.length <= SWARM_TRACE.MAX_EVENT_PAYLOAD_BYTES) return payload ?? null;
  return {
    _truncated: true,
    _originalBytes: json.length,
    preview: json.slice(0, SWARM_TRACE.MAX_EVENT_PAYLOAD_BYTES - 64),
  };
}

/** 时间戳 → 文件名友好前缀（YYYY-MM-DDTHHmmss，可 ls 排序） */
function tsPrefix(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

interface RunCacheEntry {
  filePath: string;
  eventCount: number;
  /** 上次写入后文件是否以 \n 结尾；半行崩溃后会是 false，下次写入前置 \n 自愈 */
  endsWithNewline: boolean;
}

/** 探测文件最后一个字节是否是 \n（崩溃留下半行时返回 false） */
function fileEndsWithNewline(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return true; // 不存在视为干净
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return true;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, stat.size - 1);
      return buf[0] === 0x0a; /* '\n' */
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false; // 探测失败保守附 \n
  }
}

// ============================================================================
// FileSwarmTraceRepository
// ============================================================================

export class FileSwarmTraceRepository {
  private readonly storageDir: string;
  /** 缓存 runId → {filePath, eventCount}，未命中时 fallback 扫目录 */
  private readonly runCache: Map<string, RunCacheEntry> = new Map();

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    this.ensureStorageDir();
  }

  // --------------------------------------------------------------------------
  // 写入 API（同 SwarmTraceRepository 签名）
  // --------------------------------------------------------------------------

  startRun(input: StartRunInput): void {
    const fileName = `${tsPrefix(input.startedAt)}__${input.id}.jsonl`;
    const filePath = path.join(this.storageDir, fileName);
    // 文件可能已存在（同 runId 重复 startRun，对齐 SQL 的 INSERT OR REPLACE 语义）→ 探测
    const cache: RunCacheEntry = {
      filePath,
      eventCount: 0,
      endsWithNewline: fileEndsWithNewline(filePath),
    };
    this.runCache.set(input.id, cache);
    const entry: RunStartedEntry = {
      type: 'run_started',
      runId: input.id,
      sessionId: input.sessionId,
      coordinator: input.coordinator,
      startedAt: input.startedAt,
      totalAgents: input.totalAgents,
      trigger: input.trigger,
    };
    this.appendLine(cache, entry);
  }

  closeRun(input: CloseRunInput): void {
    const cache = this.resolveCache(input.id);
    if (!cache) {
      logger.warn('closeRun called for unknown runId', { runId: input.id });
      return;
    }
    const entry: RunClosedEntry = {
      type: 'run_closed',
      status: input.status,
      endedAt: input.endedAt,
      completedCount: input.completedCount,
      failedCount: input.failedCount,
      parallelPeak: input.parallelPeak,
      totalTokensIn: input.totalTokensIn,
      totalTokensOut: input.totalTokensOut,
      totalToolCalls: input.totalToolCalls,
      totalCostUsd: input.totalCostUsd,
      errorSummary: input.errorSummary,
      aggregation: input.aggregation,
    };
    this.appendLine(cache, entry);
  }

  upsertAgent(input: UpsertAgentInput): void {
    const cache = this.resolveCache(input.runId);
    if (!cache) {
      logger.warn('upsertAgent called for unknown runId', { runId: input.runId });
      return;
    }
    const entry: AgentUpsertedEntry = {
      type: 'agent_upserted',
      agentId: input.agentId,
      name: input.name,
      role: input.role,
      status: input.status,
      startTime: input.startTime,
      endTime: input.endTime,
      durationMs: input.durationMs,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      toolCalls: input.toolCalls,
      costUsd: input.costUsd,
      error: input.error,
      failureCategory: input.failureCategory,
      filesChanged: input.filesChanged ?? [],
    };
    this.appendLine(cache, entry);
  }

  appendEvent(input: AppendEventInput): void {
    const cache = this.resolveCache(input.runId);
    if (!cache) {
      logger.warn('appendEvent called for unknown runId', { runId: input.runId });
      return;
    }
    // 与 SwarmTraceRepository 同语义：超上限丢尾部，保住 head
    if (cache.eventCount >= SWARM_TRACE.MAX_EVENTS_PER_RUN) return;
    cache.eventCount += 1;
    const entry: EventEntry = {
      type: 'event',
      seq: input.seq,
      ts: input.timestamp,
      eventType: input.eventType,
      agentId: input.agentId,
      level: input.level,
      title: input.title,
      summary: input.summary,
      payload: clampPayload(input.payload),
    };
    this.appendLine(cache, entry);
  }

  // --------------------------------------------------------------------------
  // 读取 API
  // --------------------------------------------------------------------------

  listRuns(limit: number): SwarmRunListItem[] {
    const safeLimit = Math.max(1, Math.min(limit, SWARM_TRACE.MAX_LIST_LIMIT));
    const files = this.listFilesSortedDesc();
    const items: SwarmRunListItem[] = [];
    for (const file of files) {
      if (items.length >= safeLimit) break;
      const item = this.readListItem(path.join(this.storageDir, file));
      if (item) items.push(item);
    }
    return items;
  }

  getRunDetail(runId: string): SwarmRunDetail | null {
    const cache = this.resolveCache(runId);
    if (!cache) return null;
    return this.readRunDetail(cache.filePath);
  }

  deleteRun(runId: string): boolean {
    const cache = this.resolveCache(runId);
    if (!cache) return false;
    try {
      if (fs.existsSync(cache.filePath)) {
        fs.unlinkSync(cache.filePath);
      }
      this.runCache.delete(runId);
      return true;
    } catch (err) {
      logger.warn('deleteRun failed', { runId, err });
      return false;
    }
  }

  /** 仅供测试 / 维护使用：清空所有 swarm trace 文件 */
  clearAll(): void {
    try {
      if (fs.existsSync(this.storageDir)) {
        for (const f of fs.readdirSync(this.storageDir)) {
          if (f.endsWith('.jsonl')) {
            try {
              fs.unlinkSync(path.join(this.storageDir, f));
            } catch {
              /* 单文件失败不影响整体 */
            }
          }
        }
      }
    } catch (err) {
      logger.warn('clearAll failed', { err });
    }
    this.runCache.clear();
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private ensureStorageDir(): void {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
    } catch (err) {
      logger.warn('ensureStorageDir failed', { storageDir: this.storageDir, err });
    }
  }

  private appendLine(cache: RunCacheEntry, entry: SwarmRunEntry): void {
    try {
      const prefix = cache.endsWithNewline ? '' : '\n';
      fs.appendFileSync(cache.filePath, `${prefix}${JSON.stringify(entry)}\n`, 'utf-8');
      cache.endsWithNewline = true;
    } catch (err) {
      logger.warn('appendLine failed', { filePath: cache.filePath, err });
    }
  }

  /** 命中缓存 / fallback 扫目录回填；找不到则 null */
  private resolveCache(runId: string): RunCacheEntry | null {
    const cached = this.runCache.get(runId);
    if (cached) return cached;
    const found = this.scanForRunFile(runId);
    if (!found) return null;
    const eventCount = this.countEvents(found);
    const next: RunCacheEntry = {
      filePath: found,
      eventCount,
      endsWithNewline: fileEndsWithNewline(found),
    };
    this.runCache.set(runId, next);
    return next;
  }

  private scanForRunFile(runId: string): string | null {
    try {
      if (!fs.existsSync(this.storageDir)) return null;
      const files = fs.readdirSync(this.storageDir);
      for (const f of files) {
        if (f.endsWith(`__${runId}.jsonl`)) {
          return path.join(this.storageDir, f);
        }
      }
    } catch (err) {
      logger.warn('scanForRunFile failed', { runId, err });
    }
    return null;
  }

  private countEvents(filePath: string): number {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      let count = 0;
      for (const line of data.split('\n')) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { type?: string };
          if (parsed.type === 'event') count += 1;
        } catch {
          /* 容忍崩溃留的半行 */
        }
      }
      return count;
    } catch {
      return 0;
    }
  }

  private listFilesSortedDesc(): string[] {
    try {
      if (!fs.existsSync(this.storageDir)) return [];
      return fs
        .readdirSync(this.storageDir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** 读单文件 → ListItem（轻量回放，不构造完整 events 数组） */
  private readListItem(filePath: string): SwarmRunListItem | null {
    const replay = this.replayFile(filePath);
    if (!replay) return null;
    const { started, closed, agentLatest } = replay;
    if (!started) return null;

    if (closed) {
      return {
        id: started.runId,
        sessionId: started.sessionId,
        status: closed.status,
        coordinator: started.coordinator,
        startedAt: started.startedAt,
        endedAt: closed.endedAt,
        durationMs: closed.endedAt - started.startedAt,
        totalAgents: started.totalAgents,
        completedCount: closed.completedCount,
        failedCount: closed.failedCount,
        totalCostUsd: closed.totalCostUsd,
        totalTokensIn: closed.totalTokensIn,
        totalTokensOut: closed.totalTokensOut,
        trigger: started.trigger,
      };
    }

    // running 状态：从 agent rollup 累加
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCostUsd = 0;
    let completedCount = 0;
    let failedCount = 0;
    for (const a of agentLatest.values()) {
      totalTokensIn += a.tokensIn;
      totalTokensOut += a.tokensOut;
      totalCostUsd += a.costUsd;
      if (a.status === 'completed') completedCount += 1;
      if (a.status === 'failed') failedCount += 1;
    }
    return {
      id: started.runId,
      sessionId: started.sessionId,
      status: 'running',
      coordinator: started.coordinator,
      startedAt: started.startedAt,
      endedAt: null,
      durationMs: null,
      totalAgents: started.totalAgents,
      completedCount,
      failedCount,
      totalCostUsd,
      totalTokensIn,
      totalTokensOut,
      trigger: started.trigger,
    };
  }

  private readRunDetail(filePath: string): SwarmRunDetail | null {
    const replay = this.replayFile(filePath);
    if (!replay || !replay.started) return null;
    const { started, closed, agentLatest, events } = replay;

    // 推导未 closed 时的 totals
    let totalsTokensIn = 0;
    let totalsTokensOut = 0;
    let totalsToolCalls = 0;
    let totalsCostUsd = 0;
    let completed = 0;
    let failed = 0;
    for (const a of agentLatest.values()) {
      totalsTokensIn += a.tokensIn;
      totalsTokensOut += a.tokensOut;
      totalsToolCalls += a.toolCalls;
      totalsCostUsd += a.costUsd;
      if (a.status === 'completed') completed += 1;
      if (a.status === 'failed') failed += 1;
    }

    const run: SwarmRunRecord = {
      id: started.runId,
      sessionId: started.sessionId,
      coordinator: started.coordinator,
      status: closed?.status ?? 'running',
      startedAt: started.startedAt,
      endedAt: closed?.endedAt ?? null,
      totalAgents: started.totalAgents,
      completedCount: closed?.completedCount ?? completed,
      failedCount: closed?.failedCount ?? failed,
      parallelPeak: closed?.parallelPeak ?? 0,
      totalTokensIn: closed?.totalTokensIn ?? totalsTokensIn,
      totalTokensOut: closed?.totalTokensOut ?? totalsTokensOut,
      totalToolCalls: closed?.totalToolCalls ?? totalsToolCalls,
      totalCostUsd: closed?.totalCostUsd ?? totalsCostUsd,
      trigger: started.trigger,
      errorSummary: closed?.errorSummary ?? null,
      aggregation: closed?.aggregation ?? null,
      tags: [],
    };

    const agents: SwarmRunAgentRecord[] = Array.from(agentLatest.values())
      .sort((a, b) => {
        // 同 SQL：start_time ASC NULLS LAST
        const av = a.startTime ?? Number.POSITIVE_INFINITY;
        const bv = b.startTime ?? Number.POSITIVE_INFINITY;
        return av - bv;
      })
      .map((a) => ({
        runId: started.runId,
        agentId: a.agentId,
        name: a.name,
        role: a.role,
        status: a.status,
        startTime: a.startTime,
        endTime: a.endTime,
        durationMs: a.durationMs,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        toolCalls: a.toolCalls,
        costUsd: a.costUsd,
        error: a.error,
        failureCategory: a.failureCategory,
        filesChanged: a.filesChanged,
      }));

    // events 按 seq ASC；id 用回放顺序号模拟 SQL AUTOINCREMENT
    const eventsSorted: SwarmRunEventRecord[] = events
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((e, idx) => ({
        id: idx + 1,
        runId: started.runId,
        seq: e.seq,
        timestamp: e.ts,
        eventType: e.eventType,
        agentId: e.agentId,
        level: e.level,
        title: e.title,
        summary: e.summary,
        payload: e.payload,
      }));

    return { run, agents, events: eventsSorted };
  }

  /** 单文件逐行回放成 (started, closed, agentLatest, events)；half-line 容忍 */
  private replayFile(filePath: string): {
    started: RunStartedEntry | null;
    closed: RunClosedEntry | null;
    agentLatest: Map<string, AgentUpsertedEntry>;
    events: EventEntry[];
  } | null {
    let data: string;
    try {
      data = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
    const lines = data.split('\n');
    let started: RunStartedEntry | null = null;
    let closed: RunClosedEntry | null = null;
    const agentLatest = new Map<string, AgentUpsertedEntry>();
    const events: EventEntry[] = [];
    for (const line of lines) {
      if (!line) continue;
      let parsed: SwarmRunEntry;
      try {
        parsed = JSON.parse(line) as SwarmRunEntry;
      } catch {
        continue; // 半行/破损跳过
      }
      switch (parsed.type) {
        case 'run_started':
          started = parsed;
          break;
        case 'run_closed':
          closed = parsed;
          break;
        case 'agent_upserted':
          // 同 SQL ON CONFLICT 语义：后写覆盖前写
          agentLatest.set(parsed.agentId, parsed);
          break;
        case 'event':
          events.push(parsed);
          break;
        default:
          // 未来扩展类型，先跳过
          break;
      }
    }
    return { started, closed, agentLatest, events };
  }
}
