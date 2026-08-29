import type { EvalRunStamp } from '../../shared/contract/evaluation';
import { SCAFFOLD_PROFILE } from '../../shared/constants/agent';
import { AGENT_RUNTIME_DEFAULTS } from '../agent/agentRuntimeDefaults';
import { DEFAULT_GOAL_ALLOW_SWARM } from '../agent/goalModeController';
import { resolveScaffoldProfileForModel } from '../agent/runtime/scaffoldProfile';
import { DEFAULT_COMPRESSION_PIPELINE_ENABLED } from '../context/compressionPipeline';
import { getConfigService } from '../services/core/configService';
import { DEFAULT_SETTINGS } from '../services/core/configDefaults';
import { DEFAULT_ENABLED_SKILLS } from '../services/skills/skillRepositories';

type RunShape = EvalRunStamp['shape'];

export function resolveProductionShape(model: string): RunShape {
  const contextCompression = getConfigService().getSettings().contextCompression
    ?? DEFAULT_SETTINGS.contextCompression;
  const skills = Object.values(DEFAULT_ENABLED_SKILLS).flat();
  const scaffold = resolveScaffoldProfileForModel(model);

  return {
    skills,
    memory: AGENT_RUNTIME_DEFAULTS.persistLongTermMemory,
    swarm: DEFAULT_GOAL_ALLOW_SWARM,
    harness: {
      name: 'production',
      contextCompression: contextCompression?.enabled !== false,
      compressionPipeline: DEFAULT_COMPRESSION_PIPELINE_ENABLED,
      scaffoldProfile: SCAFFOLD_PROFILE.ENABLED,
      thinkingInjection: scaffold.thinkingInjection,
      hooksEnabled: AGENT_RUNTIME_DEFAULTS.enableHooks,
      toolMode: AGENT_RUNTIME_DEFAULTS.toolMode,
    },
  };
}
