/** 定时任务 agent 动作允许的 agentType（保存时校验；存量行读取不校验）。 */
export const CRON_AGENT_TYPES = ['default', 'heartbeat', 'dream', 'distill'] as const;
