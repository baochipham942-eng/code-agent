// ============================================================================
// cronRunCostMeter —— 单次 cron 运行的成本计量器（N-CRON-RUN-LEDGER-VISIBLE）。
// 用 scoped cost limit 充当纯计量：BudgetService 每落一条真实 usage 就记入当前
// scoped 上下文（budgetService.recordUsage → recordScopedUsage/recordScopedCost），
// run 结束后读 getCostUsd() 写进执行记录的 cost 字段。
//
// 任务声明了单次预算（maxRunBudget）时，计量器直接以该预算为上限——与
// runWithCronJobBudget 同阈值、同 in-flight 失败语义：越线抛 ScopedCostLimitExceededError，
// 由外层 runWithCronJobBudget 转成既有的「exceeded its $… budget limit」消息
// （该消息归 cronExecutionPolicy / N-CRON-BUDGET-STOP-NOTICE 单，这里绝不复述）。
// 未声明预算时用永不触顶的上限：真正的外层闸仍是 unattended 全局预算池。
//
// 嵌套方向（关键）：计量器必须是最内层。AsyncLocalStorage 只记最内层上下文，
// 所以 meter.run 包住真正的模型调用，runWithCronJobBudget 包在外面。带预算时
// 计量器与 job budget 用同一上限，越线仍抛 ScopedCostLimitExceededError，外层
// 原样转成既有措辞；计量器放在外层会让本次成本读成 $0。
// ============================================================================
import { createScopedCostLimit } from '../services/core/scopedCostLimit';
import { isCronAgentActionResult, isRecord } from './cronNormalizers';

/** 纯计量档的上限：高到永不触顶；若真越过，说明预算体系整体失守，fail-loud 合理。 */
const METER_ONLY_CAP_USD = 1_000_000;

export interface CronRunCostMeter {
  /** 在计量器作用域内执行一次模型调用；带预算时越线抛 ScopedCostLimitExceededError（同 job budget 语义）。 */
  run<T>(operation: () => Promise<T>): Promise<T>;
  /** 本次（可能多段）调用的实测成本（USD）；无模型调用时为 0。 */
  getCostUsd(): number;
}

/**
 * @param maxRunBudget 任务的单次预算。传 undefined = 只计量不设闸（role-wake 历史上
 * 无预算闸，本单不扩权）。
 */
export function createCronRunCostMeter(maxRunBudget: number | null | undefined): CronRunCostMeter {
  const scoped = createScopedCostLimit(
    maxRunBudget != null && maxRunBudget > 0 ? maxRunBudget : METER_ONLY_CAP_USD,
  );
  return {
    run: (operation) => scoped.run(operation),
    getCostUsd: () => scoped.getCostUsd(),
  };
}

/**
 * 从 run 的产出读实测成本：成功路径读 result.costUsd（CronAgentActionResult 与
 * role-wake 结果两个形状），失败路径读挂在 Error 上的 cronRunCostUsd。
 * 其他 result 一律 undefined——云端结果、模型自由文本不猜成本。
 */
export function readCronRunCostUsd(source: unknown): number | undefined {
  if (source instanceof Error) {
    return readPositiveCost((source as Error & { cronRunCostUsd?: unknown }).cronRunCostUsd);
  }
  if (!isRecord(source) || source.costUsd === undefined) return undefined;
  const knownShape = isCronAgentActionResult(source)
    || (typeof source.status === 'string' && typeof source.roleId === 'string');
  if (!knownShape) return undefined;
  return readPositiveCost(source.costUsd);
}

function readPositiveCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 把实测成本挂到失败的 Error 上（失败路径的记账通道；成功路径走 result.costUsd）。 */
export function attachCronRunCost(error: unknown, meter: CronRunCostMeter): void {
  const costUsd = meter.getCostUsd();
  if (costUsd <= 0 || !(error instanceof Error) || 'cronRunCostUsd' in error) return;
  (error as Error & { cronRunCostUsd?: number }).cronRunCostUsd = costUsd;
}
