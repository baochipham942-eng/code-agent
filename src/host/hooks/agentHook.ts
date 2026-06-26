// ============================================================================
// Agent Hook Executor
// Execute hooks as AI agent roles with configurable prompts
// ============================================================================

import type { AnyHookContext } from '../protocol/events';
import type { AICompletionFn } from './promptHook';

export interface AgentHookConfig {
  /** Agent role name (e.g., 'reviewer', 'security-auditor') */
  agent: string;
  /** Custom prompt for the agent (optional) */
  agentPrompt?: string;
  /** Hook context to analyze */
  context: AnyHookContext;
}

/**
 * Execute an agent hook by calling AI with a role-based prompt
 */
export async function executeAgentHook(
  config: AgentHookConfig,
  aiCompletion?: AICompletionFn
): Promise<{ output: string; success: boolean }> {
  if (!aiCompletion) {
    return { output: 'No AI completion function available', success: false };
  }

  const contextStr = JSON.stringify(config.context, null, 2);
  const prompt = config.agentPrompt
    ? `${config.agentPrompt}\n\nContext:\n${contextStr}`
    : `As a ${config.agent}, analyze the following context and provide feedback:\n\n${contextStr}`;

  const result = await aiCompletion(prompt);
  return { output: result, success: true };
}
