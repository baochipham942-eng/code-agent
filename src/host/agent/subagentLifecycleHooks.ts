import type { AgentTask } from './agentTask';
import type { SubagentConfig, SubagentExecutionContext } from './subagentExecutorTypes';

export function startSubagentLifecycle(input: {
  agentTask: AgentTask;
  agentId: string;
  prompt: string;
  config: SubagentConfig;
  context: SubagentExecutionContext;
}): string {
  const sessionId = input.context.sessionId.trim() || 'unknown';
  const hooks = input.context.hooks;
  if (hooks) {
    input.agentTask.onHook = (event, payload) => {
      if (event === 'TaskCreated') {
        hooks.triggerTaskCreated(payload.taskId, payload.agentType, sessionId).catch(() => {});
      } else if (event === 'TaskCompleted') {
        hooks.triggerTaskCompleted(
          payload.taskId,
          payload.agentType,
          payload.success ?? false,
          sessionId,
        ).catch(() => {});
      }
    };
  }
  input.agentTask.register();
  input.agentTask.start();
  hooks?.triggerSubagentStart(
    input.config.name,
    input.agentId,
    input.prompt,
    sessionId,
    input.context.parentToolUseId,
  ).catch(() => {});
  return sessionId;
}
