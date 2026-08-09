/** Tools exposed to the foreground text brain. Background task runs deny them. */
export const SESSION_COMMAND_CENTER_TOOL_NAMES = [
  'delegate_task',
  'steer_task',
  'cancel_task',
  'task_status',
] as const;

/**
 * 前台只读工具（ADR-056）。
 *
 * 判据「本轮不以 / 开头且无 goal ⇒ 指挥台」实测覆盖 99.1% 的轮次（真库 1364 条用户消息
 * 里只有 12 条以 / 开头），所以它是默认档而不是特例。原本的 5 元组把「读」也一并拿走，
 * 造成两次真机体验伤害（08-06 验收 FAIL、08-07 Windows 测试者连问 5 轮）——用户要读一个
 * 文件，前台却只能派活。
 *
 * ADR-054 自己写的原则是「前台只允许**短时、低副作用**操作」（docs/architecture/workbench.md），
 * 这四个工具毫秒级、零写入，本来就该在里面；5 元组比它所实现的 ADR 更窄。
 *
 * 边界画在**副作用**上，不画在「回答 vs 派活」上：写入、跑命令、联网、要审批的工作
 * 照旧只能 delegate_task。权限不打折——Read/Grep 仍然过 folder-trust 与权限档，这里放开的
 * 是「模型能不能发起」，不是「能不能绕过审批」。
 */
export const SESSION_COMMAND_CENTER_READ_TOOL_NAMES = [
  'Read',
  'Grep',
  'Glob',
  'ListDirectory',
] as const;

export const SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES = [
  ...SESSION_COMMAND_CENTER_TOOL_NAMES,
  'AskUserQuestion',
  ...SESSION_COMMAND_CENTER_READ_TOOL_NAMES,
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
