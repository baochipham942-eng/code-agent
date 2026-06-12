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

/** cron 的 '/dream --auto'（人不在场）vs 手动 /dream。dream 写的是经 FTS 门验证的
 * memory（被动数据、可删除、轨迹库为权威），非可执行资产，故 auto 仍直写不走草稿；
 * 但 flag 必须解析并在报告/日志标注，便于审计与回滚 auto 写入（audit 复核）。 */
function isAutoTriggered(args: string | undefined): boolean {
  return /(^|\s)--auto(\s|$)/.test(args ?? '');
}

export async function executeDreamRun(
  request: SkillExecutionRequest,
  overrides: DreamExecutorOverrides = {},
): Promise<string> {
  const auto = isAutoTriggered(request.args);
  logger.info('Dream run starting', { workingDirectory: request.workingDirectory, auto });
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
    `Dream executor: runDreamMemoryConsolidation (${auto ? 'auto-triggered' : 'manual'})`,
    formatDreamRunReport(report),
  ].join('\n');
}

/** 启动期调用（initBackgroundServices）：把 dream 接入 executor 桥 */
export function registerDreamSkillExecutor(overrides: DreamExecutorOverrides = {}): void {
  registerSkillExecutor(DREAM_SKILL_NAME, (request) => executeDreamRun(request, overrides));
  logger.info('Dream skill executor registered');
}
