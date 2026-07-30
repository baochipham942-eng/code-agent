// ============================================================================
// 语音派活的完成语义证据门（X5.5-A2-a）
//
// 「派活成功 ≠ 用户目标完成，完成目标才叫完成。」
//
// TaskManager 的 `task_completed` 只说明 agent 循环正常退出了，不说明用户要的事做成了。
// 此前语音任务卡把这个事件直接翻成「已完成」，于是一轮什么都没干、只留下一句
// 「我已经帮你建好了」的 run，在屏幕上和耳朵里都是绿的——这正是本仓反复踩的谎报。
//
// 判据只认机器留下的东西（ADR-050 的产物证据口径），一律不认模型的自述：
//   改过文件 / 产出过工件 / 有过成功的校验命令 / 有过 commit。
// 拿不到证据不等于「失败」，只等于「还没核验」——所以给中间态而不是报错。
//
// 为什么读 completion summary 而不是自己再刮一遍会话：这份 run 级记录是
// finalizeRun 在发终态事件**之前** await 落盘的（见 runFinalizer.finalizeRun），
// 本来就是为「这一轮到底干了什么」建的单一真源，再刮一遍等于养第二份判据。
// ============================================================================

import type { CompletionSummaryRecord } from '../../../shared/contract';
import { VOICE_WORK_EVIDENCE_TIMEOUT_MS } from '../../../shared/constants/voice';
import { readLatestCompletionSummaryRecord } from '../../session/completionSummaryService';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceWorkEvidence');

/**
 * 这一轮有没有留下产物证据。
 *
 * 刻意**不**把 `visibleFinalAnswer` 算进来：模型最后那句话恰恰是要防的那样东西，
 * 把它当证据等于把门开在门里。
 */
export function hasVoiceWorkEvidence(record: CompletionSummaryRecord | null | undefined): boolean {
  if (!record) return false;
  return record.changedFiles.length > 0
    || record.artifactRefs.length > 0
    || record.commitIds.length > 0
    || record.verificationEvidence.some((evidence) => evidence.success);
}

/**
 * 一件语音派出的活跑完了，该报「已完成」还是「已结束 · 待核验」。
 *
 * `dispatchedAtMs` 是这件活派出去的时刻：同一条会话里可能躺着上一轮的 completion
 * summary，拿旧记录当这一轮的证据就是把别人的功劳记在这件活头上。早于派活时刻的
 * 记录一律不认。
 *
 * 读盘失败或超时一律退到 `unverified`：证据门 fail-closed，读不到证据就是没有证据。
 * 超时那条不是保险起见——这次查询卡在 run 终态之前，而终态要还 D4 抬严票，
 * 查询永不返回等于把会话永久钉死在只读档（见 VOICE_WORK_EVIDENCE_TIMEOUT_MS）。
 */
export async function resolveVoiceWorkOutcome(
  neoSessionId: string,
  dispatchedAtMs: number,
): Promise<'done' | 'unverified'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const record = await Promise.race([
      readLatestCompletionSummaryRecord(neoSessionId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), VOICE_WORK_EVIDENCE_TIMEOUT_MS);
      }),
    ]);
    if (!record || record.endedAt < dispatchedAtMs) return 'unverified';
    return hasVoiceWorkEvidence(record) ? 'done' : 'unverified';
  } catch (err) {
    logger.warn('completion evidence lookup failed; falling back to unverified', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    return 'unverified';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
