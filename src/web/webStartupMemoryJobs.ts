// ============================================================================
// Light Memory consolidation cron 注册 —— 发行版路径接线
//
// 注册点原本只在 app/initBackgroundServices.ts:478（那条不在任何发行版中执行的
// Electron main 路径，见 src/host/index.ts 头注释），所以**发行版里这个 job 从未被
// 创建过**——记忆只写不整理。
//
// 刀6 已翻真写。启动时不只创建缺失 job，也会把旧版本遗留的 dryRun=true action
// 原位升级为当前默认值，避免“代码已真写、存量调度仍永远空跑”的双态。
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
    const existing = cron.listJobs({ tags: [MEMORY_CONSOLIDATION.JOB_TAG] })[0];
    if (existing) {
      const expectedAction = {
        type: 'memory-consolidation' as const,
        dryRun: MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT,
      };
      if (
        existing.action.type !== 'memory-consolidation'
        || existing.action.dryRun !== expectedAction.dryRun
      ) {
        await cron.updateJob(existing.id, { action: expectedAction });
        logger.info('Light Memory consolidation job action updated', {
          jobId: existing.id,
          dryRun: expectedAction.dryRun,
        });
      }
      return;
    }
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
