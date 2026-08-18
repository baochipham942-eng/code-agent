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
