import type { CronJobExecution } from '@shared/contract';
import { readWakeSkipFromResult, wakeSkipReasonText, type WakeSkipTexts } from '@shared/cronRunLedger';

/** 执行记录 → 「未运行」原因一句话；非跳过的角色唤醒返回 null；未登记原因回落原文。 */
export function wakeSkipSentence(execution: Pick<CronJobExecution, 'result'>, texts: WakeSkipTexts): string | null {
  const view = readWakeSkipFromResult(execution.result);
  if (!view) return null;
  return view.info ? wakeSkipReasonText(view.info, texts) : view.raw;
}
