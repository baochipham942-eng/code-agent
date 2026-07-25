// ============================================================================
// Light Memory consolidation cron 注册 —— 发行版路径接线
//
// 注册点原本只在 app/initBackgroundServices.ts:478（那条不在任何发行版中执行的
// Electron main 路径，见 src/host/index.ts 头注释），所以**发行版里这个 job 从未被
// 创建过**——记忆只写不整理。
//
// 重要：job 仍按 MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT（当前 = true）注册，
// 即只输出"打算怎么合并/删除"的计划与 diff、不落盘。这是 consolidation 作者的原意
// （见该常量注释："dry-run 验证信息无损后再改 false 开真写"）。接线让计划变得可观测，
// 翻成真写是另一个决定——那会动用户的记忆文件，必须先看过至少一次 dry-run 输出。
//
// 成本：consolidation 走 quick model，但有健康门——记忆文件数低于
// MEMORY_CONSOLIDATION.FILE_COUNT_THRESHOLD 且 INDEX 未超预算时直接跳过、不烧 token。
//
// 单独成文件而非内联进 webServer：后者有效行数逼近 max-lines(1000, skipComments)，
// 与 webCapabilityBootstrap.ts / webStartupRetention.ts / webLogBridgeSetup.ts 同一手法。
// ============================================================================

import { MEMORY_CONSOLIDATION } from '../shared/constants';
import { createLogger } from '../host/services/infra/logger';

const logger = createLogger('WebStartupMemoryJobs');

/**
 * 幂等注册（by tag）：已存在同 tag 的 job 就不重复建。
 * 必须在 initCronService() 之后调用。
 */
export async function registerMemoryConsolidationJob(): Promise<void> {
  try {
    const { getCronService } = await import('../host/cron/cronService');
    const cron = getCronService();
    if (cron.listJobs({ tags: [MEMORY_CONSOLIDATION.JOB_TAG] }).length > 0) return;
    await cron.createJob({
      name: '[Maintenance] Light Memory consolidation',
      description: 'Compress ~/.code-agent/memory without losing information (quick model).',
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: MEMORY_CONSOLIDATION.CRON_EXPRESSION },
      action: { type: 'memory-consolidation', dryRun: MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT },
      enabled: true,
      tags: [MEMORY_CONSOLIDATION.JOB_TAG],
    });
    logger.info('Light Memory consolidation job registered', {
      expression: MEMORY_CONSOLIDATION.CRON_EXPRESSION,
      dryRun: MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT,
    });
  } catch (error) {
    logger.warn('Light Memory consolidation job registration failed (non-blocking):', (error as Error).message);
  }
}
