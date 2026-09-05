import type { EvalRunStamp } from '@shared/contract/evaluation';
import { SCAFFOLD_PROFILE } from '@shared/constants/agent';
import { AGENT_RUNTIME_DEFAULTS, getDefaultInstalledBuiltinPluginIds } from '@host/agent/agentRuntimeDefaults';
import { DEFAULT_GOAL_ALLOW_SWARM } from '@host/agent/goalModeController';
import { resolveScaffoldProfileForModel } from '@host/agent/runtime/scaffoldProfile';
import { DEFAULT_COMPRESSION_PIPELINE_ENABLED } from '@host/context/compressionPipeline';
import { getConfigService } from '@host/services/core/configService';
import { DEFAULT_SETTINGS } from '@host/services/core/configDefaults';
import { DEFAULT_ENABLED_SKILLS } from '@host/services/skills/skillRepositories';

type RunShape = EvalRunStamp['shape'];

export function resolveProductionShape(model: string): RunShape {
  const contextCompression = getConfigService().getSettings().contextCompression
    ?? DEFAULT_SETTINGS.contextCompression;
  const skills = Object.values(DEFAULT_ENABLED_SKILLS).flat();
  const scaffold = resolveScaffoldProfileForModel(model);

  const plugins = getDefaultInstalledBuiltinPluginIds();

  return {
    skills,
    plugins,
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
