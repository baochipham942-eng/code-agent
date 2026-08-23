// ============================================================================
// Light Memory consolidation cron 注册 —— 发行版路径接线
//
// 注册点原本只在 app/initBackgroundServices.ts:478（那条不在任何发行版中执行的
// Electron main 路径，见 src/host/index.ts 头注释），所以**发行版里这个 job 从未被
// 创建过**——记忆只写不整理。
//
// 自动整理默认 dry-run；真写必须由用户在设置页显式开启（settings.memory.autoConsolidate）。
// 启动只把 job 对齐到用户显式落盘的设置，不存在无设置依据的静默升级。
//
// 成本：consolidation 走 quick model，但有健康门——记忆文件数低于
// MEMORY_CONSOLIDATION.FILE_COUNT_THRESHOLD 且 INDEX 未超预算时直接跳过、不烧 token。
//
// 单独成文件而非内联进 webServer：后者有效行数逼近 max-lines(1000, skipComments)，
// 与 webCapabilityBootstrap.ts / webStartupRetention.ts / webLogBridgeSetup.ts 同一手法。
// ============================================================================

import { createLogger } from '../host/services/infra/logger';

const logger = createLogger('WebStartupMemoryJobs');

/**
 * 幂等注册/对齐（by tag）：无 job 按设置创建；已有 job 仅在 dryRun 与
 * 用户显式设置不一致时对齐。必须在 initCronService() 之后调用。
 */
export async function registerMemoryConsolidationJob(): Promise<void> {
  try {
    const { getConfigService } = await import('../host/services/core/configService');
    const autoConsolidate = getConfigService().getSettings().memory?.autoConsolidate === true;
    const { syncMemoryConsolidationJob } = await import('../host/lightMemory/consolidationJobSync');
    await syncMemoryConsolidationJob(autoConsolidate);
  } catch (error) {
    logger.warn('Light Memory consolidation job registration failed (non-blocking):', (error as Error).message);
  }
}
