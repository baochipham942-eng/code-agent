import type { AgentEngineKind } from '../../../shared/contract/agentEngine';
import { isManifestBackedAgentEngineKind } from '../../../shared/externalEngineManifest';
import { getSubagentEngine } from '../agentDefinition';

type SpawnAgentEngineResolution =
  | { engine: AgentEngineKind }
  | { error: string };

export function resolveSpawnAgentEngine(
  requestedEngine: unknown,
  parallel: boolean | undefined,
  isDynamicMode: boolean,
  role: string | undefined,
): SpawnAgentEngineResolution {
  if (requestedEngine !== undefined && parallel) {
    return { error: 'engine override is only supported for a single declarative role.' };
  }
  if (requestedEngine !== undefined && isDynamicMode) {
    return { error: 'engine override requires a declarative role.' };
  }
  if (requestedEngine !== undefined && !isManifestBackedAgentEngineKind(requestedEngine)) {
    return { error: `Unsupported subagent engine: ${String(requestedEngine)}` };
  }
  return {
    engine: requestedEngine
      ?? (role ? getSubagentEngine(role) : undefined)
      ?? 'native',
  };
}
