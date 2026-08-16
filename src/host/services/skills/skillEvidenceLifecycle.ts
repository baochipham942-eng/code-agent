import { createLogger } from '../infra/logger';
import { getSkillDiscoveryService } from './skillDiscoveryService';
import { getSkillRepositoryService } from './skillRepositoryService';
import {
  finalizeDistilledSkillTurn,
  markDistilledSkillTurnSignal,
  recordDistilledSkillVote,
  type DistilledSkillVoteResult,
} from './distillSignalStore';

const logger = createLogger('SkillEvidenceLifecycle');

async function applyLifecycleAction(result: DistilledSkillVoteResult): Promise<void> {
  if (!result.changed) return;
  if (result.action === 'split') {
    logger.info('Distilled skill requires task-class split before retirement', {
      skillName: result.record.skillName,
      importanceCount: result.record.importanceCount,
      buckets: result.buckets,
    });
    return;
  }
  if (result.action !== 'retire' && result.action !== 'merge') return;

  const repository = getSkillRepositoryService();
  await repository.initialize();
  repository.disableSkill(result.record.skillName);
  getSkillDiscoveryService().registerSkillsToToolSearch();
  logger.info('Distilled skill soft-retired from runtime discovery', {
    skillName: result.record.skillName,
    action: result.action,
    importanceCount: result.record.importanceCount,
    mergedInto: result.record.mergedInto,
  });
}

export function markDistilledSkillSelected(input: {
  turnId: string;
  skillName: string;
  sessionId?: string;
  taskClass?: string;
}): boolean {
  return markDistilledSkillTurnSignal({ ...input, kind: 'selected' });
}

export function markDistilledSkillAdopted(input: {
  turnId: string;
  skillName: string;
  sessionId?: string;
  taskClass?: string;
}): boolean {
  return markDistilledSkillTurnSignal({ ...input, kind: 'adopted' });
}

export async function finalizeDistilledSkillEvidenceTurn(input: {
  turnId: string;
  taskClass?: string;
}): Promise<DistilledSkillVoteResult[]> {
  const results = finalizeDistilledSkillTurn(input);
  await Promise.all(results.map((result) => applyLifecycleAction(result)));
  return results;
}

export async function recordDistilledSkillFeedback(input: {
  skillName: string;
  feedbackId: string;
  rating: 1 | -1;
  sessionId?: string;
  taskClass?: string;
}): Promise<DistilledSkillVoteResult | null> {
  const result = recordDistilledSkillVote({
    skillName: input.skillName,
    eventKey: `feedback:${input.feedbackId}`,
    outcome: input.rating === 1 ? 'adopted' : 'negative_feedback',
    sessionId: input.sessionId,
    taskClass: input.taskClass,
  });
  if (result) await applyLifecycleAction(result);
  return result;
}
