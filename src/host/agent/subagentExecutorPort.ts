import type { SubagentConfig, SubagentContext, SubagentResult } from './subagentExecutorTypes';

export interface SubagentExecutorPort {
  execute(
    prompt: string,
    config: SubagentConfig,
    context: SubagentContext,
  ): Promise<SubagentResult>;
}
