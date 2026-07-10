// ============================================================================
// FileSwarmTraceRepository Tests
// ============================================================================
// 覆盖：
//   - 写入/读取 round-trip（startRun + upsertAgent + appendEvent + closeRun）
//   - agent_upserted 同 ID 后写覆盖前写
//   - listRuns 按时间倒序 + limit 截断
//   - MAX_EVENTS_PER_RUN 超限丢尾部
//   - MAX_EVENT_PAYLOAD_BYTES 超限 truncation marker
//   - running 状态（无 run_closed 时）从 agent rollup 推算
//   - deleteRun / clearAll
//   - half-line（崩溃留半行）容忍
//   - cache miss（新实例从既有目录恢复）
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  FileSwarmTraceRepository,
  type StartRunInput,
  type UpsertAgentInput,
  type AppendEventInput,
  type CloseRunInput,
} from '../../../src/host/services/core/repositories/FileSwarmTraceRepository';
import { SWARM_TRACE } from '../../../src/shared/constants/storage';
import { createSwarmTraceStorageId } from '../../../src/shared/contract/swarm';

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-swarm-trace-'));
}

function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function startRun(input: Partial<StartRunInput> & { id: string; startedAt: number }): StartRunInput {
  return {
    id: input.id,
    sessionId: input.sessionId ?? 'session-1',
    coordinator: input.coordinator ?? 'hybrid',
    startedAt: input.startedAt,
    totalAgents: input.totalAgents ?? 2,
    trigger: input.trigger ?? 'llm-spawn',
  };
}

function upsertAgent(input: Partial<UpsertAgentInput> & { runId: string; agentId: string }): UpsertAgentInput {
  return {
    runId: input.runId,
    agentId: input.agentId,
    name: input.name ?? 'coder',
    role: input.role ?? 'coder',
    status: input.status ?? 'running',
    startTime: input.startTime ?? 1000,
    endTime: input.endTime ?? null,
    durationMs: input.durationMs ?? null,
    tokensIn: input.tokensIn ?? 100,
    tokensOut: input.tokensOut ?? 50,
    toolCalls: input.toolCalls ?? 3,
    costUsd: input.costUsd ?? 0.01,
    error: input.error ?? null,
    failureCategory: input.failureCategory ?? null,
    filesChanged: input.filesChanged ?? [],
  };
}

function appendEvent(input: Partial<AppendEventInput> & { runId: string; seq: number; timestamp: number }): AppendEventInput {
  return {
    runId: input.runId,
    seq: input.seq,
    timestamp: input.timestamp,
    eventType: input.eventType ?? 'swarm:agent:updated',
    agentId: input.agentId ?? 'agent-1',
    level: input.level ?? 'info',
    title: input.title ?? 'agent:updated',
    summary: input.summary ?? 'running',
    payload: input.payload ?? { foo: 'bar' },
  };
}

function closeRun(input: Partial<CloseRunInput> & { id: string; endedAt: number }): CloseRunInput {
  return {
    id: input.id,
    status: input.status ?? 'completed',
    endedAt: input.endedAt,
    completedCount: input.completedCount ?? 2,
    failedCount: input.failedCount ?? 0,
    parallelPeak: input.parallelPeak ?? 2,
    totalTokensIn: input.totalTokensIn ?? 300,
    totalTokensOut: input.totalTokensOut ?? 150,
    totalToolCalls: input.totalToolCalls ?? 8,
    totalCostUsd: input.totalCostUsd ?? 0.05,
    errorSummary: input.errorSummary ?? null,
    aggregation: input.aggregation ?? null,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('FileSwarmTraceRepository', () => {
  let dir: string;
  let repo: FileSwarmTraceRepository;

  beforeEach(() => {
    dir = makeTempDir();
    repo = new FileSwarmTraceRepository(dir);
  });

  afterEach(() => {
    rmDir(dir);
  });

  it('round-trip: startRun + agent + event + closeRun → getRunDetail 完整', () => {
    repo.startRun(startRun({ id: 'run-1', startedAt: 1_000_000, totalAgents: 1 }));
    repo.upsertAgent(upsertAgent({ runId: 'run-1', agentId: 'a1', status: 'completed', endTime: 2_000, tokensIn: 120, tokensOut: 80 }));
    repo.appendEvent(appendEvent({ runId: 'run-1', seq: 0, timestamp: 1_500, eventType: 'swarm:started' }));
    repo.appendEvent(appendEvent({ runId: 'run-1', seq: 1, timestamp: 1_600, eventType: 'swarm:agent:completed' }));
    repo.closeRun(closeRun({ id: 'run-1', endedAt: 2_000_000, completedCount: 1, failedCount: 0 }));

    const detail = repo.getRunDetail('run-1');
    expect(detail).not.toBeNull();
    expect(detail!.run.id).toBe('run-1');
    expect(detail!.run.status).toBe('completed');
    expect(detail!.run.startedAt).toBe(1_000_000);
    expect(detail!.run.endedAt).toBe(2_000_000);
    expect(detail!.agents).toHaveLength(1);
    expect(detail!.agents[0].agentId).toBe('a1');
    expect(detail!.agents[0].tokensIn).toBe(120);
    expect(detail!.events).toHaveLength(2);
    expect(detail!.events[0].seq).toBe(0);
    expect(detail!.events[1].seq).toBe(1);
    expect(detail!.events[0].id).toBe(1); // 模拟 AUTOINCREMENT
    expect(detail!.events[1].id).toBe(2);
  });

  it('agent_upserted 同 ID 后写覆盖前写（match SQL ON CONFLICT 语义）', () => {
    repo.startRun(startRun({ id: 'run-2', startedAt: 1_000_000 }));
    repo.upsertAgent(upsertAgent({ runId: 'run-2', agentId: 'a1', status: 'running', tokensIn: 50, tokensOut: 20 }));
    repo.upsertAgent(upsertAgent({ runId: 'run-2', agentId: 'a1', status: 'completed', tokensIn: 200, tokensOut: 100 }));

    const detail = repo.getRunDetail('run-2');
    expect(detail!.agents).toHaveLength(1);
    expect(detail!.agents[0].status).toBe('completed');
    expect(detail!.agents[0].tokensIn).toBe(200);
    expect(detail!.agents[0].tokensOut).toBe(100);
  });

  it('startRun 同 runId 二次写入时替换旧 JSONL，不残留旧事件', () => {
    repo.startRun(startRun({ id: 'run-replace', startedAt: 1_000_000, totalAgents: 1 }));
    repo.appendEvent(appendEvent({ runId: 'run-replace', seq: 0, timestamp: 1_500, summary: 'old-event' }));
    repo.closeRun(closeRun({ id: 'run-replace', endedAt: 2_000_000, completedCount: 1 }));

    repo.startRun(startRun({ id: 'run-replace', startedAt: 3_000_000, totalAgents: 2 }));
    repo.appendEvent(appendEvent({ runId: 'run-replace', seq: 0, timestamp: 3_500, summary: 'new-event' }));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('run-replace.jsonl'));
    expect(files).toHaveLength(1);
    const detail = repo.getRunDetail('run-replace');
    expect(detail!.run.startedAt).toBe(3_000_000);
    expect(detail!.run.totalAgents).toBe(2);
    expect(detail!.run.status).toBe('running');
    expect(detail!.events.map((e) => e.summary)).toEqual(['new-event']);
  });

  it('opaque storage id keeps the same logical runId in two sessions as separate files', () => {
    const scopeA = { sessionId: 'session-a', runId: 'same-run', treeId: 'tree-a' };
    const scopeB = { sessionId: 'session-b', runId: 'same-run', treeId: 'tree-b' };
    const storageA = createSwarmTraceStorageId(scopeA);
    const storageB = createSwarmTraceStorageId(scopeB);
    repo.startRun(startRun({ id: storageA, sessionId: scopeA.sessionId, startedAt: 1_000 }));
    repo.startRun(startRun({ id: storageB, sessionId: scopeB.sessionId, startedAt: 2_000 }));
    repo.appendEvent(appendEvent({ runId: storageA, seq: 0, timestamp: 1_100, agentId: 'agent-a' }));
    repo.appendEvent(appendEvent({ runId: storageB, seq: 0, timestamp: 2_100, agentId: 'agent-b' }));

    expect(repo.getRunDetail(storageA)?.events.map((event) => event.agentId)).toEqual(['agent-a']);
    expect(repo.getRunDetail(storageB)?.events.map((event) => event.agentId)).toEqual(['agent-b']);
    expect(repo.listRuns(10).map((run) => run.id).sort()).toEqual([storageA, storageB].sort());
    expect(fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl'))).toHaveLength(2);
  });

  it('listRuns 按 startedAt 倒序 + limit 截断', () => {
    repo.startRun(startRun({ id: 'r-old', startedAt: new Date('2026-01-01T12:00:00').getTime() }));
    repo.closeRun(closeRun({ id: 'r-old', endedAt: 1_000_000_000 }));
    repo.startRun(startRun({ id: 'r-mid', startedAt: new Date('2026-03-01T12:00:00').getTime() }));
    repo.closeRun(closeRun({ id: 'r-mid', endedAt: 2_000_000_000 }));
    repo.startRun(startRun({ id: 'r-new', startedAt: new Date('2026-05-01T12:00:00').getTime() }));
    repo.closeRun(closeRun({ id: 'r-new', endedAt: 3_000_000_000 }));

    const items = repo.listRuns(2);
    expect(items.map((it) => it.id)).toEqual(['r-new', 'r-mid']);
  });

  it('running 状态（无 run_closed）从 agent rollup 推算 totals', () => {
    repo.startRun(startRun({ id: 'run-3', startedAt: 1_000_000, totalAgents: 2 }));
    repo.upsertAgent(upsertAgent({ runId: 'run-3', agentId: 'a1', status: 'completed', tokensIn: 100, tokensOut: 50, costUsd: 0.01 }));
    repo.upsertAgent(upsertAgent({ runId: 'run-3', agentId: 'a2', status: 'running', tokensIn: 80, tokensOut: 40, costUsd: 0.005 }));

    const detail = repo.getRunDetail('run-3');
    expect(detail!.run.status).toBe('running');
    expect(detail!.run.endedAt).toBeNull();
    expect(detail!.run.totalTokensIn).toBe(180);
    expect(detail!.run.totalTokensOut).toBe(90);
    expect(detail!.run.totalCostUsd).toBeCloseTo(0.015);
    expect(detail!.run.completedCount).toBe(1);
    expect(detail!.run.failedCount).toBe(0);

    const item = repo.listRuns(10).find((it) => it.id === 'run-3');
    expect(item!.status).toBe('running');
    expect(item!.totalTokensIn).toBe(180);
  });

  it('MAX_EVENTS_PER_RUN 超限丢尾部', () => {
    repo.startRun(startRun({ id: 'run-cap', startedAt: 1_000_000 }));
    const max = SWARM_TRACE.MAX_EVENTS_PER_RUN;
    for (let i = 0; i < max + 5; i++) {
      repo.appendEvent(appendEvent({ runId: 'run-cap', seq: i, timestamp: 1_000 + i }));
    }
    const detail = repo.getRunDetail('run-cap');
    expect(detail!.events).toHaveLength(max);
    expect(detail!.events[max - 1].seq).toBe(max - 1);
  });

  it('MAX_EVENT_PAYLOAD_BYTES 超限 → truncation marker', () => {
    repo.startRun(startRun({ id: 'run-big', startedAt: 1_000_000 }));
    const huge = 'x'.repeat(SWARM_TRACE.MAX_EVENT_PAYLOAD_BYTES + 1000);
    repo.appendEvent(appendEvent({ runId: 'run-big', seq: 0, timestamp: 1_500, payload: { blob: huge } }));

    const detail = repo.getRunDetail('run-big');
    const payload = detail!.events[0].payload as Record<string, unknown>;
    expect(payload._truncated).toBe(true);
    expect(typeof payload._originalBytes).toBe('number');
    expect(typeof payload.preview).toBe('string');
    expect((payload.preview as string).length).toBeLessThanOrEqual(SWARM_TRACE.MAX_EVENT_PAYLOAD_BYTES);
  });

  it('deleteRun 删文件 + 清缓存，再 getRunDetail 返回 null', () => {
    repo.startRun(startRun({ id: 'run-del', startedAt: 1_000_000 }));
    repo.closeRun(closeRun({ id: 'run-del', endedAt: 2_000_000 }));
    expect(repo.getRunDetail('run-del')).not.toBeNull();

    expect(repo.deleteRun('run-del')).toBe(true);
    expect(repo.getRunDetail('run-del')).toBeNull();
    // 目录里没残留
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(0);

    // 重复 delete 返回 false（已不存在）
    expect(repo.deleteRun('run-del')).toBe(false);
  });

  it('clearAll 清空所有 jsonl + 缓存', () => {
    repo.startRun(startRun({ id: 'r1', startedAt: 1_000_000 }));
    repo.startRun(startRun({ id: 'r2', startedAt: 2_000_000 }));
    repo.startRun(startRun({ id: 'r3', startedAt: 3_000_000 }));
    expect(repo.listRuns(10)).toHaveLength(3);

    repo.clearAll();
    expect(repo.listRuns(10)).toHaveLength(0);
    expect(repo.getRunDetail('r1')).toBeNull();
  });

  it('half-line 容忍：进程重启后新实例 probe \\n 自愈 + 继续写', () => {
    // 旧进程：start + 写一条事件
    repo.startRun(startRun({ id: 'run-half', startedAt: 1_000_000 }));
    repo.appendEvent(appendEvent({ runId: 'run-half', seq: 0, timestamp: 1_500 }));

    // 模拟崩溃留下的半行（kernel 没刷完整就掉电）
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('run-half.jsonl'));
    expect(files).toHaveLength(1);
    const filePath = path.join(dir, files[0]);
    fs.appendFileSync(filePath, '{"type":"event","seq":1,', 'utf-8');

    // 新进程：新实例不带 cache → resolveCache 会 probe 末尾 \n → 自愈
    const repo2 = new FileSwarmTraceRepository(dir);
    repo2.appendEvent(appendEvent({ runId: 'run-half', seq: 2, timestamp: 1_700 }));

    const detail = repo2.getRunDetail('run-half');
    expect(detail).not.toBeNull();
    // seq=1 半行被 JSON.parse skip；seq=0 + seq=2 保留
    expect(detail!.events.map((e) => e.seq)).toEqual([0, 2]);
  });

  it('同实例内 read-only replay 也容忍半行（getRunDetail 不抛）', () => {
    repo.startRun(startRun({ id: 'run-half2', startedAt: 1_000_000 }));
    repo.appendEvent(appendEvent({ runId: 'run-half2', seq: 0, timestamp: 1_500 }));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('run-half2.jsonl'));
    fs.appendFileSync(path.join(dir, files[0]), '{"type":"event","seq":1,', 'utf-8');

    const detail = repo.getRunDetail('run-half2');
    expect(detail).not.toBeNull();
    expect(detail!.events.map((e) => e.seq)).toEqual([0]);
  });

  it('新实例从既有目录恢复（cache miss → scan）', () => {
    repo.startRun(startRun({ id: 'run-persist', startedAt: 1_000_000 }));
    repo.upsertAgent(upsertAgent({ runId: 'run-persist', agentId: 'a1', status: 'completed', tokensIn: 100, tokensOut: 50 }));
    repo.appendEvent(appendEvent({ runId: 'run-persist', seq: 0, timestamp: 1_500 }));
    repo.closeRun(closeRun({ id: 'run-persist', endedAt: 2_000_000 }));

    // 模拟进程重启：换新实例读同目录
    const repo2 = new FileSwarmTraceRepository(dir);
    const detail = repo2.getRunDetail('run-persist');
    expect(detail).not.toBeNull();
    expect(detail!.run.status).toBe('completed');
    expect(detail!.agents).toHaveLength(1);
    expect(detail!.events).toHaveLength(1);

    // listRuns 也能扫到
    const items = repo2.listRuns(10);
    expect(items.map((it) => it.id)).toContain('run-persist');
  });

  it('未知 runId 的写入操作不抛错（warn + skip）', () => {
    // 没 startRun 直接 upsert/append/close 应该静默 skip，不抛
    expect(() => repo.upsertAgent(upsertAgent({ runId: 'ghost', agentId: 'a1' }))).not.toThrow();
    expect(() => repo.appendEvent(appendEvent({ runId: 'ghost', seq: 0, timestamp: 1_000 }))).not.toThrow();
    expect(() => repo.closeRun(closeRun({ id: 'ghost', endedAt: 1_000 }))).not.toThrow();

    // 目录里不应该有任何 jsonl
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(0);
  });

  it('listRuns limit 越界被 clamp 到 [1, MAX_LIST_LIMIT]', () => {
    repo.startRun(startRun({ id: 'r1', startedAt: 1_000_000 }));
    repo.startRun(startRun({ id: 'r2', startedAt: 2_000_000 }));
    // limit=0 应被 clamp 到 1
    expect(repo.listRuns(0)).toHaveLength(1);
    // limit 超 MAX_LIST_LIMIT 不会爆
    expect(repo.listRuns(SWARM_TRACE.MAX_LIST_LIMIT + 1000)).toHaveLength(2);
  });

  it('storageDir 不存在时构造函数自动创建', () => {
    const fresh = path.join(dir, 'nested', 'storage');
    expect(fs.existsSync(fresh)).toBe(false);
    new FileSwarmTraceRepository(fresh);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
