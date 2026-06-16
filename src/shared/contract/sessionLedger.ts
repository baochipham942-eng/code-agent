// ============================================================================
// 事件账本 第三期(3a) · 一本账会话复盘 契约
//
// ADR-022 §四第三期 + ADR-023 决策点 1 = P2（读侧逻辑投影，不建物理大表）。
// "总账"在本项目落地为：把各 append-only 小账本 + 成本，按时间合并成统一时间线
// 「读出」——纯只读投影，不落地成新表、不动任何写路径。
//
// 一条 LedgerEntry = 总账里的一行流水（来自某条 lane 的一个事件，已归一化）。
// SessionLedger   = 一个会话的「一本账」：按时间排序的 entries + 成本汇总 header。
// ============================================================================

/** 总账的事件来源泳道。成本不入 entries 流，走 SessionLedger.cost 汇总。 */
export type LedgerLane = 'message' | 'task' | 'swarm' | 'decision' | 'execution';

/** 总账里的一行流水（归一化后的统一形状）。 */
export interface LedgerEntry {
  /** 事件发生时刻（毫秒）；全账按此升序排列 */
  at: number;
  /** 来自哪条泳道 */
  lane: LedgerLane;
  /** 泳道内的事件子类型（如 task 的 created/done，decision 的 allow/deny，execution 的 begin/complete） */
  kind: string;
  /** 人类可读的一行摘要 */
  summary: string;
  /** 回溯原始记录的引用 id（messageId / taskId / runId / decisionId / executionId） */
  refId?: string;
  /** 附加结构化细节（不参与排序，供出口/UI 选用） */
  detail?: Record<string, unknown>;
}

/** 会话成本汇总（来自 telemetry_sessions，会话级标量，不是时序事件）。 */
export interface SessionLedgerCost {
  estimatedCost: number;
  tokensIn: number;
  tokensOut: number;
}

/** 一个会话的「一本账」。 */
export interface SessionLedger {
  sessionId: string;
  /** 本账生成时刻（调用方传入，禁裸 Date.now()） */
  generatedAt: number;
  /** 按 at 升序、同刻按泳道输入序稳定排列的全链路流水 */
  entries: LedgerEntry[];
  /** 成本汇总 */
  cost: SessionLedgerCost;
  /** 各泳道贡献的流水条数（合并后统计） */
  laneCounts: Record<LedgerLane, number>;
}

/** 空成本（lane 读失败或无数据时的安全默认）。 */
export const EMPTY_LEDGER_COST: SessionLedgerCost = {
  estimatedCost: 0,
  tokensIn: 0,
  tokensOut: 0,
};
