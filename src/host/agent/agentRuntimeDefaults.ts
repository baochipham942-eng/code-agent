import { BUILTIN_CAPABILITY_IDS } from '../plugins/builtin/builtinCapabilityIds';
import { isBuiltinCapabilityInstalledSync } from '../plugins/builtin/computerUse/installState';

export const AGENT_RUNTIME_DEFAULTS = {
  persistLongTermMemory: true,
  includeRecentConversations: true,
  enableHooks: true,
  toolMode: 'deferred',
} as const;

/**
 * 生产默认装着的 builtin 能力插件——状态文件缺席即「已安装」，所以这就是用户开箱的那一套。
 *
 * 放在这里而不是 plugins 目录：评测中心是内部插件包，只能 import 宿主 SDK 表里的模块，
 * 而它要报「本轮形态 vs 生产默认」就得拿到这份清单。这里只读安装状态、不碰 catalog 的
 * 插件入口，所以不会把 8 个 builtin 的实现拖进任何调用方。
 */
export function getDefaultInstalledBuiltinPluginIds(): string[] {
  // 必须包一层 lambda：isBuiltinCapabilityInstalledSync 的第二个参数是 env，
  // 直接传函数引用会把 filter 的 index 当环境变量表塞进去。
  return BUILTIN_CAPABILITY_IDS
    .filter((pluginId) => isBuiltinCapabilityInstalledSync(pluginId))
    .slice()
    .sort();
}
