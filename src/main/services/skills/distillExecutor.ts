// ============================================================================
// DistillExecutor — /distill 的 service 层执行入口（生产装配）
// ============================================================================
// 把六阶段确定性编排器（distillService.runDistill）装配上生产依赖并注册进
// skillExecutorRegistry。手动 /distill 与 cron 的 '/distill --auto' 都经过
// buildSkillInvocationContext 的同一个 executor 桥进入这里。
//
// --auto（人不在场）→ mode 'auto'：产出一律走草稿（command-drafts /
// skillDraftQueue），不自激活。
// ============================================================================

import { CORE_AGENT_IDS } from '../../agent/hybrid/coreAgents';
import { getDatabase } from '../core/databaseService';
import { getPromptCommandService } from '../commands/promptCommandService';
import { emitCommandFile } from '../commands/commandFileEmitter';
import { createLogger } from '../infra/logger';
import { BUILTIN_SKILLS } from './builtinSkills';
import { getSkillDiscoveryService } from './skillDiscoveryService';
import { listSkillDrafts } from './skillDraftQueue';
import { emitSkillAsset } from './distillSkillEmitter';
import { llmDistillProposalGenerator } from './distillProposalGenerator';
import { registerSkillExecutor, type SkillExecutionRequest } from './skillExecutorRegistry';
import {
  formatDistillRunReport,
  runDistill,
  type DistillAssetInventory,
  type DistillEmitters,
  type DistillRunMode,
  type DistillRunOptions,
} from './distillService';

const logger = createLogger('DistillExecutor');

export const DISTILL_SKILL_NAME = 'distill';

function parseMode(args: string | undefined): DistillRunMode {
  return /(^|\s)--auto(\s|$)/.test(args ?? '') ? 'auto' : 'manual';
}

/** Phase 1 盘点：commands + skills（含 builtin）+ core agents + 待确认草稿名 */
async function buildInventory(workingDirectory: string): Promise<DistillAssetInventory> {
  const commands = await getPromptCommandService()
    .listCommands(workingDirectory)
    .catch(() => []);

  let skills: Array<{ name: string; description?: string }>;
  try {
    const discovery = getSkillDiscoveryService();
    skills = discovery.getAllSkills().map((skill) => ({ name: skill.name, description: skill.description }));
  } catch {
    skills = BUILTIN_SKILLS.map((skill) => ({ name: skill.name, description: skill.description }));
  }

  // 待确认草稿也占名：避免重复提案（rejected patternKey 的去重由 skillDraftQueue 入队时兜底）
  const pendingDraftNames = await listSkillDrafts()
    .then((drafts) => drafts.map((draft) => draft.name))
    .catch(() => [] as string[]);

  return {
    commands: commands.map((command) => ({ name: command.name, description: command.description })),
    skills,
    agents: [...CORE_AGENT_IDS],
    rejectedNames: pendingDraftNames,
  };
}

function buildEmitters(workingDirectory: string): DistillEmitters {
  return {
    emitCommand: (proposal, opts) =>
      emitCommandFile(
        { name: proposal.name, description: proposal.description, body: proposal.body },
        { draft: opts.draft },
      ),
    emitSkill: (proposal, opts) =>
      emitSkillAsset(
        { name: proposal.name, description: proposal.description, body: proposal.body },
        { draft: opts.draft, workingDirectory },
      ),
  };
}

export type DistillExecutorOverrides = Partial<
  Pick<DistillRunOptions, 'db' | 'inventory' | 'proposalGenerator' | 'emitters' | 'signalExtractor' | 'now'>
>;

/** 生产 executor。overrides 供集成测试注入（DB 副本 / 临时产出目录等）。 */
export async function executeDistillRun(
  request: SkillExecutionRequest,
  overrides: DistillExecutorOverrides = {},
): Promise<string> {
  const mode = parseMode(request.args);
  logger.info('Distill run starting', { mode, workingDirectory: request.workingDirectory });
  const report = await runDistill({
    db: overrides.db ?? getDatabase(),
    mode,
    projectPath: request.workingDirectory || null,
    inventory: overrides.inventory ?? (() => buildInventory(request.workingDirectory)),
    proposalGenerator: overrides.proposalGenerator ?? llmDistillProposalGenerator,
    emitters: overrides.emitters ?? buildEmitters(request.workingDirectory),
    signalExtractor: overrides.signalExtractor,
    now: overrides.now,
  });
  logger.info('Distill run finished', {
    mode,
    phase: report.phase,
    verified: report.verified.length,
    emitted: report.emitted.length,
  });
  return formatDistillRunReport(report);
}

/** 启动期调用（initBackgroundServices）：把 distill 接入 executor 桥 */
export function registerDistillSkillExecutor(): void {
  registerSkillExecutor(DISTILL_SKILL_NAME, (request) => executeDistillRun(request));
  logger.info('Distill skill executor registered');
}
