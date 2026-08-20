// ============================================================================
// Light Memory consolidation job 与用户设置的同步（N-MEM-CONSOLSAFE 第二波）
//
// 唯一的 dryRun 决策口：settings.memory.autoConsolidate。
//   - 未配置 / false → job 保持 dry-run（只演练出报告，不写盘）
//   - true           → job 真写回（consolidation 自带审计 fail-closed，见 consolidation.ts）
//
// 与 2026-08-20 撤掉的「启动静默升级」的区别：这里的升级/降级由用户显式落盘的
// 设置驱动，设置没动过时启动路径不会改写已有 job 动作。
// 放在 host 层而非 web 层：settings IPC（host）与 web 启动路径都要调用，
// host 不能反向 import src/web。
// ============================================================================

import { MEMORY_CONSOLIDATION } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ConsolidationJobSync');

/**
 * 幂等对齐（by tag）：无 job 则按设置创建；有 job 且 dryRun 与设置不一致则更新。
 * 必须在 initCronService() 之后调用。
 */
export async function syncMemoryConsolidationJob(autoConsolidate: boolean): Promise<void> {
  const dryRun = autoConsolidate !== true;
  const { getCronService } = await import('../cron/cronService');
  const cron = getCronService();
  const existing = cron.listJobs({ tags: [MEMORY_CONSOLIDATION.JOB_TAG] })[0];

  if (!existing) {
    await cron.createJob({
      name: '[Maintenance] Light Memory consolidation',
      description: 'Compress ~/.code-agent/memory without losing information (quick model).',
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: MEMORY_CONSOLIDATION.CRON_EXPRESSION },
      action: { type: 'memory-consolidation', dryRun },
      enabled: true,
      tags: [MEMORY_CONSOLIDATION.JOB_TAG],
    });
    logger.info('Light Memory consolidation job registered', {
      expression: MEMORY_CONSOLIDATION.CRON_EXPRESSION,
      dryRun,
    });
    return;
  }

  const currentDryRun = existing.action.type === 'memory-consolidation'
    ? existing.action.dryRun !== false
    : undefined;
  if (currentDryRun === dryRun) return;

  await cron.updateJob(existing.id, {
    action: { type: 'memory-consolidation', dryRun },
  });
  logger.info('Light Memory consolidation job dryRun aligned to settings', {
    jobId: existing.id,
    dryRun,
  });
}
