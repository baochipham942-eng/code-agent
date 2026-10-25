import type { LastToolFailure, LastToolStep } from '@shared/contract/backgroundTask';
import type { Translations } from '../i18n';
import { humanizeToolStep } from './humanizeToolStep';
import { humanizeToolError, type HumanizedToolError } from './toolExecutionPresentation';

/**
 * lastToolFailure 只在任务终态展示（N-MEDIA-GEN-MUSIC-FALLBACK-FU1）：运行中不亮——
 * 中间的失败步不给用户看，host 也可能马上清掉它（同名工具后续成功）。
 * cancelled 不算：那是用户自己的动作，有自己的故事，不叠工具失败叙事。
 */
const LAST_TOOL_FAILURE_VISIBLE_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'completed',
  'expired',
  'orphaned',
]);

export function isLastToolFailureVisible(status: string | undefined): boolean {
  return status !== undefined && LAST_TOOL_FAILURE_VISIBLE_STATUSES.has(status);
}

/**
 * 终态任务的 lastToolFailure → 人话出路。复用聊天流那套 humanizeToolError 的
 * code 登记文案（含 {alternatives} 插值），不另维护一份翻译。
 */
export function describeLastToolFailure(
  failure: LastToolFailure | undefined,
  t: Translations,
): HumanizedToolError | undefined {
  if (!failure) return undefined;
  return humanizeToolError(undefined, failure.tool, t, {
    code: failure.code,
    ...(failure.alternatives ? { alternatives: failure.alternatives } : {}),
  }) ?? undefined;
}

export function describeLastToolStep(
  step: LastToolStep | undefined,
  t: Translations,
): string | undefined {
  if (!step) return undefined;
  const targetArgs = step.target
    ? {
      file_path: step.target,
      path: step.target,
      notebook_path: step.target,
      command: step.target,
      agentId: step.target,
      target: step.target,
    }
    : undefined;
  return humanizeToolStep(step.tool, targetArgs, t);
}

export function isDelegationTool(name: string): boolean {
  return name === 'delegate_task' || name === 'spawn_agent';
}
