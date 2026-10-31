// ============================================================================
// Cron event decisions (N-TRIGGER-OBSERVE-MODE) — 逐事件决策的纯推导
// ----------------------------------------------------------------------------
// 每个进入合批窗的事件恰好一条 kind 'event' 记录：
//   dropped     ← 队列溢出 / 单 run 携带上限 / 任务在窗内被停用（原因 = 丢弃原因）
//   unavailable ← 这一趟 run 没有成功跑完（原因 = 失败文本）
//   acted / would_act / ignored ← 模型逐事件陈述的 <cron_event_decision>（原因 = 模型原话）；
//     观察档下「act」一律记 would_act。模型没陈述的事件按 run 级结果兜底（见 fallback）。
// 观察档拦下的对外动作另记 kind 'action' 行（observeModeGate / cronResultDelivery 的 sink）。
// ============================================================================

import type { CronEventActionMode, CronEventDecisionOutcome } from '../../shared/contract/cron';
import { CRON_EVENT_DECISIONS, CRON_EVENT_TRIGGER } from '../../shared/constants';
import { truncateObserveText } from '../tools/observeModeGate';
import type { CronEventDecisionInput } from './cronEventDecisionLedger';

export type CronEventDropCause = 'queue_overflow' | 'carry_limit' | 'automation_inactive';

export interface CronDroppedEvent {
  eventId: string;
  cause: CronEventDropCause;
}

export interface StatedEventDecision {
  eventId: string;
  action: 'act' | 'ignore';
  reason: string;
}

const TAG = CRON_EVENT_DECISIONS.DECISION_TAG;
const STATED_DECISION_PATTERN = new RegExp(
  `<${TAG}\\s+id="([^"]{1,200})"\\s+action="(act|ignore)"\\s*>([\\s\\S]*?)</${TAG}\\s*>`,
  'gi',
);
/** 推送正文清洗用：整块剥掉（逐事件决策是台账数据，不进通道）。 */
export const CRON_EVENT_DECISION_BLOCK_PATTERN = new RegExp(`<${TAG}\\b[^>]*>[\\s\\S]*?</${TAG}\\s*>`, 'gi');

/** 事件 run 的说明行（在 untrusted 块之前、块外）：要求模型逐事件陈述处理与否及一句话理由。 */
export function buildEventDecisionInstruction(): string {
  return `处理完后，在最终回复里对下面块内的每一条事件各输出一行 <${TAG} id="事件 id" action="act 或 ignore">一句话理由</${TAG}>：`
    + 'act = 需要据此行动（回复/发送/写入等），ignore = 不需要处理。';
}

export function parseStatedEventDecisions(text: string): StatedEventDecision[] {
  if (!text) return [];
  const decisions = new Map<string, StatedEventDecision>();
  for (const match of text.matchAll(STATED_DECISION_PATTERN)) {
    const eventId = match[1].trim();
    if (!eventId || decisions.has(eventId)) continue;
    decisions.set(eventId, {
      eventId,
      action: match[2].toLowerCase() === 'act' ? 'act' : 'ignore',
      reason: truncateObserveText(match[3], CRON_EVENT_DECISIONS.MAX_REASON_CHARS),
    });
  }
  return [...decisions.values()];
}

function readStatedDecisions(result: unknown): Map<string, StatedEventDecision> {
  const stated = new Map<string, StatedEventDecision>();
  if (!result || typeof result !== 'object') return stated;
  const raw = (result as Record<string, unknown>).eventDecisions;
  if (!Array.isArray(raw)) return stated;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { eventId, action, reason } = item as Record<string, unknown>;
    if (typeof eventId !== 'string' || (action !== 'act' && action !== 'ignore')) continue;
    stated.set(eventId, { eventId, action, reason: typeof reason === 'string' ? reason : '' });
  }
  return stated;
}

function dropReason(cause: CronEventDropCause): string {
  switch (cause) {
    case 'queue_overflow':
      return `pending queue overflow (limit ${CRON_EVENT_TRIGGER.PENDING_QUEUE_MAX}); oldest event dropped`;
    case 'carry_limit':
      return `per-run carry limit (${CRON_EVENT_TRIGGER.MAX_EVENTS_PER_RUN} events) exceeded`;
    case 'automation_inactive':
      return 'automation was disabled or removed before the batch ran';
  }
}

export function droppedEventDecisions(
  jobId: string,
  dropped: readonly CronDroppedEvent[],
  runId?: string,
): CronEventDecisionInput[] {
  return dropped.map((event) => ({
    jobId,
    kind: 'event',
    eventId: event.eventId,
    decision: 'dropped',
    reason: dropReason(event.cause),
    ...(runId ? { runId } : {}),
  }));
}

/** executeEventJob 回来的执行记录里本推导用得上的那几样。 */
interface SettledRun {
  id?: string;
  status?: string;
  error?: string;
  result?: unknown;
}

function readSettledRun(value: unknown): SettledRun | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    result: record.result,
  };
}

export interface EventRunSettlementInput {
  jobId: string;
  mode: CronEventActionMode;
  carriedEventIds: readonly string[];
  dropped: readonly CronDroppedEvent[];
  /** executeEventJob 的返回值（CronJobExecution）；抛错时 undefined。 */
  execution: unknown;
  /** executeEventJob 抛出的错误（没抛为 undefined）。 */
  runError?: unknown;
  /** 该 run 在观察档下被拦下的对外动作条数（kind 'action' 行数）。 */
  observeActionCount: (runId: string) => number;
}

/** 一趟事件 run 结束后：每个携带事件 + 每个随本 run 报告的丢弃事件，各一条决策记录。 */
export function settleEventRunDecisions(input: EventRunSettlementInput): CronEventDecisionInput[] {
  const run = readSettledRun(input.execution);
  const runId = run?.id;
  const rows: CronEventDecisionInput[] = [];
  const withRun = runId ? { runId } : {};

  if (run?.status !== 'completed') {
    const cause = run?.error
      ?? (input.runError instanceof Error ? input.runError.message : input.runError !== undefined ? String(input.runError) : undefined);
    const reason = truncateObserveText(
      `run ${run?.status ?? 'failed to start'}${cause ? `: ${cause}` : ''}`,
      CRON_EVENT_DECISIONS.MAX_REASON_CHARS,
    );
    for (const eventId of input.carriedEventIds) {
      rows.push({ jobId: input.jobId, kind: 'event', eventId, decision: 'unavailable', reason, ...withRun });
    }
    return [...rows, ...droppedEventDecisions(input.jobId, input.dropped, runId)];
  }

  const stated = readStatedDecisions(run.result);
  const fallback = fallbackDecision(input, run, runId);
  for (const eventId of input.carriedEventIds) {
    const decision = stated.get(eventId);
    if (!decision) {
      rows.push({ jobId: input.jobId, kind: 'event', eventId, ...fallback, ...withRun });
      continue;
    }
    const outcome: CronEventDecisionOutcome = decision.action === 'ignore'
      ? 'ignored'
      : input.mode === 'observe' ? 'would_act' : 'acted';
    rows.push({
      jobId: input.jobId,
      kind: 'event',
      eventId,
      decision: outcome,
      reason: decision.reason || (decision.action === 'act' ? 'model chose to act' : 'model chose to ignore'),
      ...withRun,
    });
  }
  return [...rows, ...droppedEventDecisions(input.jobId, input.dropped, runId)];
}

/**
 * 模型没逐事件陈述时按 run 级结果兜底：观察档看本 run 有没有被拦下的对外动作；
 * 自动档看 run 是否安静收场（skipped / notifySuppressed = 没报告 = ignored）。
 */
function fallbackDecision(
  input: EventRunSettlementInput,
  run: SettledRun,
  runId: string | undefined,
): { decision: CronEventDecisionOutcome; reason: string } {
  if (input.mode === 'observe') {
    return runId && input.observeActionCount(runId) > 0
      ? { decision: 'would_act', reason: 'outbound action intercepted in observe mode (no per-event reason stated)' }
      : { decision: 'ignored', reason: 'no outbound action attempted (no per-event reason stated)' };
  }
  const result = run.result && typeof run.result === 'object' ? run.result as Record<string, unknown> : {};
  return result.skipped === true || result.notifySuppressed === true
    ? { decision: 'ignored', reason: 'run stayed quiet (no alert; no per-event reason stated)' }
    : { decision: 'acted', reason: 'run completed and reported (no per-event reason stated)' };
}
