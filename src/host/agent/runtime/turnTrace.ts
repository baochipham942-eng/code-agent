// ============================================================================
// TurnTraceRecorder — 一个 run 内「决策 → dispatch → compaction」的结构化 trace
// ============================================================================
//
// G20：此前 loop decision 只 logger.debug 就丢了，没有统一的「一个 turn 内
// 决策→执行→观察」结构化记录。本模块提供一个 always-on、本地、可 grep/回放的
// trace：in-memory 累加，增量 append 到 per-session JSONL（不碰 SQLite，无 migration）。
//
// 设计目标：让"为什么这个 turn 这么走"可被复现，反过来用数据验证 G1/G7/G11/G12
// 这类争议（决策死区、DAG 是否死代码、压缩路径是否协调）是真 Gap 还是误判。
// ============================================================================

import path from 'path';
import { appendFileSync, mkdirSync } from 'fs';
import { getPath } from '../../platform/appPaths';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('TurnTrace');

export type TraceEventType =
  | 'inference'
  | 'loop_decision'
  | 'tool_dispatch'
  | 'compaction'
  | 'verification'
  | 'goal_verdict'
  | 'goal_evidence_gate'
  | 'deliverables_declaration';

export interface TraceEvent {
  ts: number;
  sessionId: string;
  turnIndex: number;
  type: TraceEventType;
  data: Record<string, unknown>;
}

/**
 * 一个 run 内的结构化 turn trace。每个 AgentLoop 实例持有一个。
 * record() 只入内存；flush() 增量落盘，fire-and-forget 安全（失败只 warn）。
 */
export class TurnTraceRecorder {
  private events: TraceEvent[] = [];
  private flushedCount = 0;
  private currentTurn = 0;
  private readonly filePath: string;

  constructor(private readonly sessionId: string) {
    this.filePath = path.join(getPath('userData'), 'traces', `${sessionId}.jsonl`);
  }

  /** 切换当前 turn index，后续 record 的事件归属此 turn */
  setTurn(turnIndex: number): void {
    this.currentTurn = turnIndex;
  }

  /** 记一条 trace 事件（仅入内存） */
  record(type: TraceEventType, data: Record<string, unknown>): void {
    this.events.push({
      ts: Date.now(),
      sessionId: this.sessionId,
      turnIndex: this.currentTurn,
      type,
      data,
    });
  }

  /** 当前已记录的全部事件（测试 / 进程内消费用） */
  getEvents(): readonly TraceEvent[] {
    return this.events;
  }

  /** 增量 append 未落盘的事件到 per-session JSONL。失败只 warn，不抛。 */
  flush(): void {
    const pending = this.events.slice(this.flushedCount);
    if (pending.length === 0) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const lines = pending.map((e) => JSON.stringify(e)).join('\n') + '\n';
      appendFileSync(this.filePath, lines, 'utf-8');
      this.flushedCount = this.events.length;
    } catch (err) {
      logger.warn('flush failed', err);
    }
  }
}
