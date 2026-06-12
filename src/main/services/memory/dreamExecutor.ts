// ============================================================================
// DreamExecutor — /dream 的 service 层执行入口（生产装配）
// ============================================================================
// 把五阶段确定性编排器（dreamMemoryService.runDreamMemoryConsolidation）
// 装配上生产依赖并注册进 skillExecutorRegistry。手动 /dream 与 cron 的
// '/dream --auto' 都经过 buildSkillInvocationContext 的 executor 桥进入这里。
// ============================================================================

import { getDatabase } from '../core/databaseService';
import { createLogger } from '../infra/logger';
import { registerSkillExecutor, type SkillExecutionRequest } from '../skills/skillExecutorRegistry';
import {
  formatDreamRunReport,
  runDreamMemoryConsolidation,
  type DreamRunOptions,
} from './dreamMemoryService';

const logger = createLogger('DreamExecutor');

export const DREAM_SKILL_NAME = 'dream';

export type DreamExecutorOverrides = Partial<
  Pick<DreamRunOptions, 'db' | 'candidateExtractor' | 'memoryIO' | 'now' | 'windowDays' | 'sessionLimit' | 'pruneOlderThanDays'>
>;

export async function executeDreamRun(
  request: SkillExecutionRequest,
  overrides: DreamExecutorOverrides = {},
): Promise<string> {
  logger.info('Dream run starting', { workingDirectory: request.workingDirectory });
  const report = await runDreamMemoryConsolidation({
    db: overrides.db ?? getDatabase(),
    projectPath: request.workingDirectory || null,
    candidateExtractor: overrides.candidateExtractor,
    memoryIO: overrides.memoryIO,
    now: overrides.now,
    windowDays: overrides.windowDays,
    sessionLimit: overrides.sessionLimit,
    pruneOlderThanDays: overrides.pruneOlderThanDays,
  });
  logger.info('Dream run finished', {
    phase: report.phase,
    sessionsReviewed: report.sessionsReviewed,
    verified: report.verified.length,
    written: report.written.length,
    pruned: report.pruned.length,
  });
  return [
    'Dream executor: runDreamMemoryConsolidation',
    formatDreamRunReport(report),
  ].join('\n');
}

/** 启动期调用（initBackgroundServices）：把 dream 接入 executor 桥 */
export function registerDreamSkillExecutor(overrides: DreamExecutorOverrides = {}): void {
  registerSkillExecutor(DREAM_SKILL_NAME, (request) => executeDreamRun(request, overrides));
  logger.info('Dream skill executor registered');
}
