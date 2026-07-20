// ============================================================================
// 事件账本 第三期(3a) · SessionLedgerProjection
//
// 读侧逻辑总账（ADR-023 P2）：把一个会话的各 append-only 小账本 + 成本，
// 归一化 → 合并 → 按时间确定性排序 → 一本账。纯函数、纯只读、零写入。
//
// 关键不变量：
//   - 不读 DB（数据由调用方注入），便于纯内存测试与复用；
//   - 每条泳道的归一化包在独立 try/catch，单泳道抛错只让该泳道为空，
//     绝不拖垮整本账（fail-safe 按 lane 隔离）；
//   - generatedAt 走参数（禁裸 Date.now()）。
// ============================================================================

import type { Message } from '../../../shared/contract/message';
import type {
  SwarmRunListItem,
  SwarmRunEventRecord,
} from '../../../shared/contract/swarmTrace';
import {
  EMPTY_LEDGER_COST,
  type LedgerEntry,
  type LedgerLane,
  type SessionLedger,
  type SessionLedgerCost,
} from '../../../shared/contract/sessionLedger';
import type { PermissionDecisionRecord } from './repositories/PermissionDecisionRepository';
import type { ToolExecutionEventRecord } from './repositories/ToolExecutionEventRepository';

/** 任务事件读出形状（SessionRepository.getSessionTaskEvents 的返回元素）。 */
export interface TaskEventInput {
  taskId: string;
  at: number;
  kind: string;
  summary?: string;
  actor?: string;
}

/**
 * 投影的输入：各泳道已读出的原生记录 + 成本汇总。
 * 任一字段允许是「访问即抛错」的 getter（来自 fail-safe facade 的异常），
 * 投影逐泳道隔离，单泳道失败不影响其余。
 */
export interface LedgerSources {
  messages: Message[];
  taskEvents: TaskEventInput[];
  swarmRuns: SwarmRunListItem[];
  swarmEvents: SwarmRunEventRecord[];
  decisions: PermissionDecisionRecord[];
  executions: ToolExecutionEventRecord[];
  cost: SessionLedgerCost;
}

const SUMMARY_MAX = 160;

function truncate(text: string, max = SUMMARY_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** 内部带插入序的 entry，用于确定性 tie-break。 */
interface SeqEntry extends LedgerEntry {
  insertionOrder: number;
}

/**
 * 单泳道归一化的 fail-safe 包裹：读 + map 全在 try/catch 内，
 * 抛错则该泳道贡献 0 条，不影响其它泳道。
 */
function collectLane<T>(
  read: () => T[],
  map: (item: T) => LedgerEntry | LedgerEntry[] | null,
  sink: SeqEntry[],
  laneCounts: Record<LedgerLane, number>,
  lane: LedgerLane,
): void {
  try {
    const items = read();
    if (!Array.isArray(items)) return;
    for (const item of items) {
      let mapped: LedgerEntry | LedgerEntry[] | null;
      try {
        mapped = map(item);
      } catch {
        continue; // 单条坏数据跳过，不毁整泳道
      }
      if (!mapped) continue;
      const arr = Array.isArray(mapped) ? mapped : [mapped];
      for (const e of arr) {
        sink.push({ ...e, insertionOrder: sink.length });
        laneCounts[lane] += 1;
      }
    }
  } catch {
    // 整泳道读取抛错（如 fail-safe facade 抛出）：该泳道计 0，静默跳过
  }
}

/**
 * 把一个会话的各泳道数据合并成「一本账」。
 * @param sessionId 会话 id
 * @param sources   各泳道已读出的原生记录 + 成本
 * @param generatedAt 本账生成时刻（毫秒，调用方传入）
 */
export function buildSessionLedger(
  sessionId: string,
  sources: LedgerSources,
  generatedAt: number,
): SessionLedger {
  const sink: SeqEntry[] = [];
  const laneCounts: Record<LedgerLane, number> = {
    message: 0,
    task: 0,
    swarm: 0,
    decision: 0,
    execution: 0,
  };

  // ── 对话 lane ──────────────────────────────────────────────────────
  collectLane<Message>(
    () => sources.messages,
    (m): LedgerEntry => ({
      at: m.timestamp,
      lane: 'message',
      kind: m.role,
      summary: truncate(m.content || (m.toolCalls?.length ? `[${m.toolCalls.length} tool call]` : '')),
      refId: m.id,
    }),
    sink, laneCounts, 'message',
  );

  // ── 任务 lane（收编 session_task_events，已是 append-only）────────────
  collectLane<TaskEventInput>(
    () => sources.taskEvents,
    (t): LedgerEntry => ({
      at: t.at,
      lane: 'task',
      kind: t.kind,
      summary: truncate(t.summary ? `${t.taskId}: ${t.summary}` : t.taskId),
      refId: t.taskId,
      ...(t.actor != null ? { detail: { actor: t.actor } } : {}),
    }),
    sink, laneCounts, 'task',
  );

  // ── 协同 lane（Swarm run 起止 + run 内事件，本段只读拼入；降级留 3b）──
  collectLane<SwarmRunListItem>(
    () => sources.swarmRuns,
    (r): LedgerEntry[] => {
      const out: LedgerEntry[] = [{
        at: r.startedAt,
        lane: 'swarm',
        kind: 'run_started',
        summary: truncate(`${r.coordinator} · ${r.totalAgents} agents · ${r.trigger}`),
        refId: r.id,
      }];
      if (r.endedAt != null) {
        out.push({
          at: r.endedAt,
          lane: 'swarm',
          kind: `run_${r.status}`,
          summary: truncate(`${r.status} · ${r.completedCount}✓/${r.failedCount}✗ · $${r.totalCostUsd.toFixed(4)}`),
          refId: r.id,
          detail: { totalCostUsd: r.totalCostUsd, tokensIn: r.totalTokensIn, tokensOut: r.totalTokensOut },
        });
      }
      return out;
    },
    sink, laneCounts, 'swarm',
  );
  collectLane<SwarmRunEventRecord>(
    () => sources.swarmEvents,
    (e): LedgerEntry => ({
      at: e.timestamp,
      lane: 'swarm',
      kind: e.eventType,
      summary: truncate(e.title || e.summary || e.eventType),
      refId: e.runId,
      detail: { agentId: e.agentId, level: e.level },
    }),
    sink, laneCounts, 'swarm',
  );

  // ── 决策 lane（权限决策链，phase1）─────────────────────────────────
  collectLane<PermissionDecisionRecord>(
    () => sources.decisions,
    (d): LedgerEntry => ({
      at: d.recordedAt,
      lane: 'decision',
      kind: d.finalOutcome,
      summary: truncate(`${d.toolName}: ${d.reason}`),
      refId: String(d.id),
      detail: { historyOutcome: d.historyOutcome, durationMs: d.durationMs },
    }),
    sink, laneCounts, 'decision',
  );

  // ── 执行 lane（工具执行生命周期，phase2）───────────────────────────
  collectLane<ToolExecutionEventRecord>(
    () => sources.executions,
    (x): LedgerEntry => ({
      at: x.recordedAt,
      lane: 'execution',
      kind: x.status ? `${x.phase}:${x.status}` : x.phase,
      summary: truncate(x.summary ? `${x.toolName} ${x.summary}` : x.toolName),
      refId: x.executionId,
      ...(x.error != null ? { detail: { error: x.error } } : {}),
    }),
    sink, laneCounts, 'execution',
  );

  // ── 确定性排序：按 at 升序，同刻按插入序（泳道输入序）稳定 tie-break ──
  sink.sort((a, b) => (a.at - b.at) || (a.insertionOrder - b.insertionOrder));

  const entries: LedgerEntry[] = sink.map(({ insertionOrder: _insertionOrder, ...entry }) => entry);

  let cost: SessionLedgerCost;
  try {
    cost = sources.cost ?? EMPTY_LEDGER_COST;
  } catch {
    cost = EMPTY_LEDGER_COST;
  }

  return { sessionId, generatedAt, entries, cost, laneCounts };
}
