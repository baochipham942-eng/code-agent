import { INTERACTION_TIMEOUTS } from './timeouts';

/**
 * 后台任务禁止递归调用的指挥台调度工具。
 * 这份拒绝集不决定文字前台工具面；前台只消费 ToolSchema.allowInTextForeground。
 */
export const SESSION_COMMAND_CENTER_TOOL_NAMES = [
  'delegate_task',
  'spawn_agent',
  'steer_task',
  'cancel_task',
  'task_status',
] as const;

/** Foreground brain should route or answer without growing into an execution run. */
export const SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS = 8;

/** Hidden task-result wakes get a deliberately small reasoning budget. */
export const SESSION_COMMAND_CENTER_WAKE_MAX_ITERATIONS = 4;

/**
 * Prevent an autonomous task chain from waking the same conversation forever.
 * A new visible user message resets this counter.
 */
export const MAX_CONSECUTIVE_WAKES = 3;

/**
 * How long a background session-command run may go without an agent event
 * before the slot is failed. Voice does not use this clock.
 */
export const SESSION_COMMAND_TASK_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

const SESSION_COMMAND_TASK_IDLE_TIMEOUT_ENV = 'CODE_AGENT_SESSION_TASK_IDLE_TIMEOUT_MS';

/** Sole reader of CODE_AGENT_SESSION_TASK_IDLE_TIMEOUT_MS. Invalid values keep the fallback. */
export function resolveSessionCommandTaskIdleTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = SESSION_COMMAND_TASK_IDLE_TIMEOUT_MS,
): number {
  const raw = env[SESSION_COMMAND_TASK_IDLE_TIMEOUT_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

/**
 * 未答审批最多给一个后台任务续多久：超过后审批豁免停止，空闲回收链照常
 * fail + cancel + 唤醒。默认沿用无人值守停车审批的 24h 兜底数字，不另造魔法数。
 */
export const SESSION_COMMAND_TASK_APPROVAL_WAIT_CAP_MS = INTERACTION_TIMEOUTS.PARKED_APPROVAL;

const SESSION_COMMAND_TASK_APPROVAL_WAIT_CAP_ENV = 'CODE_AGENT_SESSION_TASK_APPROVAL_WAIT_CAP_MS';

/** Sole reader of CODE_AGENT_SESSION_TASK_APPROVAL_WAIT_CAP_MS. Invalid values keep the fallback. */
export function resolveSessionCommandTaskApprovalWaitCapMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = SESSION_COMMAND_TASK_APPROVAL_WAIT_CAP_MS,
): number {
  const raw = env[SESSION_COMMAND_TASK_APPROVAL_WAIT_CAP_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

/**
 * 模型侧任务结果文本（resultText）的封顶字符数。UI/账本仍用 240 字 summary；
 * 前台模型读到的是这份宽松上限——SSRF 拒绝提示里的「改走 Bash curl 审批」整句
 * 必须完整到达前台，否则前台不知道下一步能做什么（FB-577）。
 */
const SESSION_COMMAND_TASK_RESULT_MODEL_MAX_CHARS = 1500;

/**
 * resultText 的单一真源：detail 规范化空白后封顶；超限保留前缀并显式标注总长，
 * 让模型知道文本被裁过。空 detail 返回 undefined——消费点回落 240 字 summary。
 * 按 code point 计数，与 compactSummary 的口径一致。
 */
export function composeSessionCommandTaskResultText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  if (chars.length <= SESSION_COMMAND_TASK_RESULT_MODEL_MAX_CHARS) return chars.join('');
  return `${chars.slice(0, SESSION_COMMAND_TASK_RESULT_MODEL_MAX_CHARS).join('')}…(truncated, ${chars.length} chars total)`;
}

/**
 * 判据单一真源：本轮是否套用指挥台 brain。
 *
 * 桌面（agentAppService）和 web（routes/agent.ts）两条路各自把工具面/迭代上限/系统上下文
 * 装配进**不同形状**的配置对象（AppServiceRunOptions vs AgentConfig），装配代码没法共用；
 * 但**判据**必须只有一份，否则改一处漏一处——本仓已两次栽在「修了桌面漏了 web」。
 */
export function isSessionCommandCenterTurn(input: {
  prompt: string;
  hasGoal: boolean;
}): boolean {
  return !input.hasGoal && !input.prompt.trimStart().startsWith('/');
}
