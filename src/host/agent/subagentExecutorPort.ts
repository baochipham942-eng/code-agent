import type { SubagentExecutionRequest, SubagentResult } from './subagentExecutorTypes';

export interface SubagentExecutorPort {
  execute(request: SubagentExecutionRequest): Promise<SubagentResult>;
}
