// ============================================================================
// decide 工具可用性判据 —— 无可用 Jev 路由时工具不进工具表、不可被 ToolSearch 搜到
// ----------------------------------------------------------------------------
// 注册面（protocol registry / DEFERRED_TOOLS_META）是无条件的——skill 的
// allowedTools 发现门按静态枚举判；「这一轮能不能用」由本谓词在枚举处收敛：
// getDeferredToolDefinitions / getLoadedDeferredToolDefinitions /
// getDeferredToolsSummary / toolSearchService.getAllSearchableTools。
// 独立成文件（不放 decide.ts）是为了让 services/toolSearch 引它时不把
// databaseService 等重依赖拉进 import 期。
// ============================================================================

import { resolveJevRoute } from '../../../model/providers/typesafeProvider';
import { createLogger } from '../../../services/infra/logger';

const logger = createLogger('DecideToolAvailability');

let warnedRouteFailure = false;

/**
 * decide 是否可用 = 是否解析得到可用 Jev 路由（官方 typesafe key 或 OpenRouter key）。
 * 路由解析抛错（如测试里缺方法的 configService mock）按「不可用」处理——
 * 枚举路径绝不能因为一次 key 读取失败而炸掉整张工具表；只 warn 一次留痕。
 */
export function isDecideToolAvailable(): boolean {
  try {
    return resolveJevRoute() !== null;
  } catch (error) {
    if (!warnedRouteFailure) {
      warnedRouteFailure = true;
      logger.warn('decide availability check failed; treating decide as unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  }
}
