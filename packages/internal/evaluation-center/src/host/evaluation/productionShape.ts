import type { EvalRunStamp } from '@shared/contract/evaluation';
import { SCAFFOLD_PROFILE } from '@shared/constants/agent';
import { AGENT_RUNTIME_DEFAULTS } from '@host/agent/agentRuntimeDefaults';
import { DEFAULT_GOAL_ALLOW_SWARM } from '@host/agent/goalModeController';
import { resolveScaffoldProfileForModel } from '@host/agent/runtime/scaffoldProfile';
import { DEFAULT_COMPRESSION_PIPELINE_ENABLED } from '@host/context/compressionPipeline';
import { getConfigService } from '@host/services/core/configService';
import { DEFAULT_SETTINGS } from '@host/services/core/configDefaults';
import { DEFAULT_ENABLED_SKILLS } from '@host/services/skills/skillRepositories';
import { BUILTIN_PLUGIN_CATALOG } from '@host/plugins/builtin/catalog';
import { isBuiltinCapabilityInstalledSync } from '@host/plugins/builtin/computerUse/installState';

type RunShape = EvalRunStamp['shape'];

export function resolveProductionShape(model: string): RunShape {
  const contextCompression = getConfigService().getSettings().contextCompression
    ?? DEFAULT_SETTINGS.contextCompression;
  const skills = Object.values(DEFAULT_ENABLED_SKILLS).flat();
  const scaffold = resolveScaffoldProfileForModel(model);

  // 生产默认的插件面：状态文件缺席即「已安装」，所以这就是用户开箱看到的那一套。
  const plugins = BUILTIN_PLUGIN_CATALOG
    .filter(({ manifest }) => isBuiltinCapabilityInstalledSync(manifest.id))
    .map(({ manifest }) => manifest.id)
    .sort();

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
