// ============================================================================
// CrashRecovery — 崩溃重放（ADR-022 第二期）
// ============================================================================
//
// 从工具执行生命周期账本（tool_execution_events）把"崩溃前正在做的事"重建回来：
//   - 未闭合执行（有 begin 无 complete）= 崩溃那一刻在飞的工具集合 = "现场"。
//   - buildRecoverySnapshot 把它们按 session 分组、带完整参数重建成结构化快照，
//     不再只是把会话翻成 interrupted 这种"光打标记"。
//   - acknowledgeRecovery 给每条在飞执行 append 一条 complete{status:'recovered'}，
//     append-only 地"闭合"，保证下次重启幂等、不重复浮现。

import type {
  OpenToolExecution,
  ToolExecutionEventRepository,
} from './repositories/ToolExecutionEventRepository';

/** 崩溃现场里被重建出来的一个工序 */
export interface RecoveredOperation {
  executionId: string;
  toolName: string;
  summary: string | null;
  params: Record<string, unknown> | null;
  /** begin 时间戳（崩溃前该工具开始执行的时刻） */
  startedAt: number;
  /** 从开始执行到恢复扫描时刻的耗时（崩溃前已跑多久） */
  elapsedMs: number;
}

/** 一个 session 在崩溃时正在进行的工序集合 */
export interface SessionRecovery {
  sessionId: string | null;
  operations: RecoveredOperation[];
}

/** 一次崩溃恢复快照：重启时从总账重建出的完整现场 */
export interface RecoverySnapshot {
  /** 恢复扫描发生的时刻 */
  recoveredAt: number;
  /** 在飞执行总数 */
  totalInFlight: number;
  /** 按 session 分组的在飞工序 */
  sessions: SessionRecovery[];
}

/** 仅依赖读取在飞执行的最小接口（便于测试 / 解耦具体仓储实现） */
export interface OpenExecutionReader {
  getOpenExecutions(): OpenToolExecution[];
}

/** 仅依赖追加 complete 的最小接口 */
export interface RecoveryAcknowledger {
  appendComplete(input: {
    executionId: string;
    toolName: string;
    status: string;
    sessionId?: string;
    recordedAt: number;
  }): void;
}

/**
 * 从未闭合执行重建崩溃现场快照。
 * @param repo 暴露 getOpenExecutions() 的仓储
 * @param now  恢复扫描时刻（毫秒），由调用方传入（禁裸 Date.now()）
 */
export function buildRecoverySnapshot(
  repo: OpenExecutionReader,
  now: number,
): RecoverySnapshot {
  const open = repo.getOpenExecutions();

  // 按 sessionId 分组（null 归一到同一组，保持 begin 时间顺序）
  const bySession = new Map<string | null, RecoveredOperation[]>();
  const order: Array<string | null> = [];
  for (const o of open) {
    const key = o.sessionId ?? null;
    if (!bySession.has(key)) {
      bySession.set(key, []);
      order.push(key);
    }
    bySession.get(key)!.push({
      executionId: o.executionId,
      toolName: o.toolName,
      summary: o.summary,
      params: o.params,
      startedAt: o.startedAt,
      elapsedMs: now - o.startedAt,
    });
  }

  return {
    recoveredAt: now,
    totalInFlight: open.length,
    sessions: order.map((sessionId) => ({
      sessionId,
      operations: bySession.get(sessionId)!,
    })),
  };
}

/**
 * 确认恢复：给快照里每条在飞执行 append 一条 complete{status:'recovered'}，
 * append-only 地闭合现场，保证下次重启幂等不重复浮现。
 * @returns 被闭合的执行条数
 */
export function acknowledgeRecovery(
  repo: RecoveryAcknowledger,
  snapshot: RecoverySnapshot,
  recordedAt: number,
): number {
  let acked = 0;
  for (const session of snapshot.sessions) {
    for (const op of session.operations) {
      repo.appendComplete({
        executionId: op.executionId,
        toolName: op.toolName,
        status: 'recovered',
        sessionId: session.sessionId ?? undefined,
        recordedAt,
      });
      acked += 1;
    }
  }
  return acked;
}

// 让 TS 知道 ToolExecutionEventRepository 满足上述接口（编译期断言，无运行时开销）
export type _RepoSatisfies = ToolExecutionEventRepository extends OpenExecutionReader & RecoveryAcknowledger ? true : never;
