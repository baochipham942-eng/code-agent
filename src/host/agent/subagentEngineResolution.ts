import type { AgentEngineKind } from '../../shared/contract/agentEngine';
import { getSubagentEngine } from './agentDefinition';
import type { SubagentConfig } from './subagentExecutorTypes';

export function resolveSubagentEngine(config: SubagentConfig): AgentEngineKind {
  return config.engine
    ?? (config.roleId ? getSubagentEngine(config.roleId) : undefined)
    ?? 'native';
}
