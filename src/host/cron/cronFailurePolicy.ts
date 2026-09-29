// ============================================================================
// CronFailurePolicy —— 定时任务失败处置策略（N-CRON-RESILIENCE）
//
// 从 cronService 抽出的失败分档逻辑（cronService.ts 已贴 max-lines 线）：
//   1. 错误分类：capacity-wait（等容量/并发槽被中断，不计失败）/ permanent（重试无用）
//      / transient（默认，走指数退避）。
//   2. 指数退避：第 n 次重试前等待 min(BASE × FACTOR^(n-1), MAX_INTERVAL)。
//   3. 失败通知去重 + 冷却：同 (jobId + 归一化错误) 在冷却窗内只告警一次；
//      最终停用通知不受冷却约束（用户必须知道任务被停了）。
// ============================================================================

import { CRON_GUARDRAILS } from '../../shared/constants';
import type { CronJobDefinition, CronJobExecution } from '../../shared/contract/cron';
import { normalizeErrorMessage } from '../lightMemory/failureJournal';
import { notificationService } from '../services/infra/notificationService';

export type CronFailureKind = 'transient' | 'permanent' | 'capacity-wait';

// ----------------------------------------------------------------------------
// 错误分类（集中一处，判据写死在这里，别处只看分类不看原文）
// ----------------------------------------------------------------------------

/** 排队等容量/并发槽时被中断：不是任务本身的失败。ConcurrencyLimiter/ConcurrencyGate 抛的形状。 */
const CAPACITY_WAIT_PATTERNS: RegExp[] = [
  /cancelled while waiting/i,
  /aborted while queued/i,
  /aborted before admission/i,
];

/**
 * permanent 判据（重试无用的确定性失败——重试只会烧钱/刷屏，直接 failed + 停用 + 告知）。
 * 只认**我们自己发出的结构化信号**：自有错误码 / 配置校验文案 / 预算护栏 / 无人值守停车码。
 *
 * 不按 HTTP 状态码、"not found" 这类文本片段判 permanent（R2 审查 Important-1）：
 * cron 的失败 message 里会包含用户 shell 命令原文与外部 stderr（execAsync 把命令和
 * 输出整个拼进 message），401/403、"command not found"、grep 无匹配（退出码 1）都会
 * 出现在任意外部文本里——按文本猜 permanent 会把临时限流/环境未就绪误判成「重试无用」
 * 直接停用任务。鉴权错/资源不存在改走 transient 退避 + 连败停用（基线行为：连败 5 次才停），
 * 宁可多退避几次，不可误停用一个正常任务。
 */
const PERMANENT_PATTERNS: RegExp[] = [
  // 自有错误码 / 配置校验（创建/更新/执行时我们自己 throw 的原文）
  /^unsupported_action$/,
  /^Unknown action type$/,
  /unsupported interval unit/i,
  /定时任务时间已过去|定时任务时间无法解析/,
  /runsOn is immutable/,
  // 无人值守停车码：审批等不到人（UNATTENDED_APPROVAL_TIMEOUT）、doom loop handback
  /UNATTENDED_APPROVAL_TIMEOUT|DOOM_LOOP_HANDBACK_STOP/,
  // 预算硬顶：单趟 $ 上限 / scoped cost limit / eval 预算护栏的固定文案（再试一次就是再烧一次钱）
  /exceeded its \$[\d.]+ budget limit|成本超限|EVAL_CASE_COST_LIMIT_EXCEEDED/,
];

/**
 * node child_process exec 失败的固定前缀（cronService 的 execAsync）——我们自己执行器的
 * 结构化标记。shell 退出码与 stderr 是任意外部文本：命中即 transient，一票否决 permanent，
 * 保证以后往 PERMANENT_PATTERNS 加判据也不会被 shell 输出误触发。
 */
const SHELL_EXEC_FAILED_PATTERN = /^Command failed: /;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyCronFailure(error: unknown | string): CronFailureKind {
  const message = typeof error === 'string' ? error : errorMessage(error);
  if (CAPACITY_WAIT_PATTERNS.some((pattern) => pattern.test(message))) return 'capacity-wait';
  if (SHELL_EXEC_FAILED_PATTERN.test(message)) return 'transient';
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(message))) return 'permanent';
  return 'transient';
}

// ----------------------------------------------------------------------------
// 指数退避
// ----------------------------------------------------------------------------

/**
 * 第 consecutiveFailureCount 次连续失败后的重试间隔（ms）。
 * 序列：30s → 60s → 120s → 240s → … 封顶 15min。count ≤ 0 视为首次，返回基数。
 */
export function cronRetryBackoffMs(consecutiveFailureCount: number): number {
  const exponent = Math.max(0, Math.floor(consecutiveFailureCount) - 1);
  const raw = CRON_GUARDRAILS.RETRY_BACKOFF_BASE_MS
    * Math.pow(CRON_GUARDRAILS.RETRY_BACKOFF_FACTOR, exponent);
  return Math.min(raw, CRON_GUARDRAILS.RETRY_BACKOFF_MAX_INTERVAL_MS);
}

// ----------------------------------------------------------------------------
// 失败通知去重 + 冷却
// ----------------------------------------------------------------------------

function normalizeCronFailureMessage(message: string): string {
  return normalizeErrorMessage(message);
}

/**
 * 同因失败告警的门闸：key = jobId + 归一化错误消息，冷却窗内只放行第一次。
 * 进程内状态，重启归零（重启本身就是一次天然冷却）。
 */
export class CronFailureNoticeGate {
  private readonly lastNotifiedAt = new Map<string, number>();

  shouldNotify(jobId: string, rawMessage: string, now: number = Date.now()): boolean {
    const key = `${jobId}:${normalizeCronFailureMessage(rawMessage)}`;
    const last = this.lastNotifiedAt.get(key);
    if (last != null && now - last < CRON_GUARDRAILS.FAILURE_NOTICE_COOLDOWN_MS) return false;
    this.lastNotifiedAt.set(key, now);
    return true;
  }
}

// ----------------------------------------------------------------------------
// 通知文案与出口
// ----------------------------------------------------------------------------

function truncateForNotice(message: string, maxChars = 200): string {
  return message.length > maxChars ? `${message.slice(0, maxChars)}…` : message;
}

/**
 * 最终停用通知（不受冷却约束）：必须带上出路——去哪重新启用、看什么错误。
 * 所有动作类型都发（不止 agent 任务）：用户不知道任务被停了正是本次回归的痛点。
 */
export function notifyCronJobDisabled(
  definition: CronJobDefinition,
  execution: CronJobExecution,
  reason: 'consecutive' | 'permanent',
): void {
  const lastError = execution.error ? truncateForNotice(execution.error) : '未知错误';
  const summary = reason === 'consecutive'
    ? `连续失败 ${CRON_GUARDRAILS.MAX_CONSECUTIVE_FAILURES} 次已自动停用。最后错误：${lastError}。`
      + '可在「自动化中心 → 定时任务」重新启用。'
    : `因配置/鉴权类错误停用（重试无效）。错误：${lastError}。`
      + '修正配置后可在「自动化中心 → 定时任务」重新启用。';
  try {
    notificationService.notifyTaskComplete(
      {
        sessionId: execution.sessionId ?? '',
        sessionTitle: `[定时] ${definition.name}`,
        summary,
        duration: execution.duration ?? 0,
        toolsUsed: [],
        succeeded: false,
      },
      { force: true }, // 停用必须让用户看见：绕过焦点门
    );
  } catch (err) {
    console.error('[CronService] Failed to send job-disabled notification:', err);
  }
}

/**
 * 定时 agent 任务跑完后发完成通知（从 cronService 平移，逻辑不变）。
 * 只对生成了会话的 agent action 发——点击通知经 NOTIFICATION_CLICKED 跳到该 session。
 * 失败告警走 noticeGate（jobId+归一化错误 去重 + 1h 冷却）；完成通知不受门约束。
 */
export function notifyCronAgentExecution(
  definition: CronJobDefinition,
  execution: CronJobExecution,
  noticeGate: CronFailureNoticeGate,
): void {
  if (definition.action.type !== 'agent' || !execution.sessionId) return;
  // cancelled = 等容量被中断，不是失败，不发失败告警
  if (execution.status !== 'completed' && execution.status !== 'failed') return;
  try {
    const succeeded = execution.status === 'completed';
    if (!succeeded
      && !noticeGate.shouldNotify(definition.id, execution.error ?? '未知错误')) {
      return; // 同因失败冷却中：这次不重复告警
    }
    notificationService.notifyTaskComplete(
      {
        sessionId: execution.sessionId,
        sessionTitle: `[定时] ${definition.name}`,
        summary: succeeded ? '定时任务已完成' : `定时任务失败：${execution.error ?? '未知错误'}`,
        duration: execution.duration ?? 0,
        toolsUsed: [],
        succeeded,
      },
      { force: true }, // 后台定时任务完成：绕过焦点门，app 前台/后台都提醒
    );
  } catch (err) {
    console.error('[CronService] notifyAgentExecution failed:', err);
  }
}

/** 末尾连续失败次数（历史最新在最后；成功一条即断链——成功就重置计数）。 */
export function countTrailingCronFailures(history: readonly CronJobExecution[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].status !== 'failed') break;
    count++;
  }
  return count;
}

/**
 * 失败的 agent 运行也要能关联到半成品 cron 会话：executeAction 的 agent 分支
 * 会把 cronSessionId 挂在抛出的 error 上，这里收进执行记录——失败告警的点击
 * 跳转和执行台账都靠它。
 */
export function adoptFailedAgentSession(execution: CronJobExecution, error: unknown): void {
  if (execution.sessionId) return;
  const sessionId = error instanceof Error && 'cronSessionId' in error
    ? (error as Error & { cronSessionId?: unknown }).cronSessionId
    : undefined;
  if (typeof sessionId === 'string' && sessionId) execution.sessionId = sessionId;
}
