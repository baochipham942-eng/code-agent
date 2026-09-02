import fs from 'node:fs';
import path from 'node:path';
import type { EvalRunPanelProbe } from '@shared/contract/evaluation';
import { resolveSessionDefaultModelConfig } from '@host/services/core/sessionDefaults';
import { inspectEvalEnvironment } from './evalEnvironment';
import { estimateEvalCostPerCase, PRICING_TABLE_VERSION } from './evalRunCostEstimate';
import { getQuickModelRuntimeInfo } from '@host/model/quickModel';
import { CONFIG_DIR_NEW } from '@shared/constants/configDir';
import {
  CALIBRATION_TRUST_THRESHOLDS,
  isTrustedCalibration,
  loadCalibrationRecordSync,
} from '@host/testing/calibration/calibrationRegistry';
import { AI_REVIEW_DIMENSION_DEFINITIONS } from '@host/testing/judge/dimensions';
import { getAiReviewPromptHash } from '@host/testing/judge/dimensionJudge';
import { getSkillDiscoveryService } from '@host/services/skills/skillDiscoveryService';
import { buildProductionCompareArm } from './evalCompareRequest';
import { enumerateCaseBank } from '../testing/caseBank';
import { splitsPath } from '@host/testing/ci/sampleSplits';

const FALLBACK_SPLIT_COUNTS: EvalRunPanelProbe['splitCounts'] = {
  'held-in': 76,
  'held-out': 52,
  safety: 12,
};

function readSplitCounts(repositoryRoot?: string): EvalRunPanelProbe['splitCounts'] {
  if (!repositoryRoot) return FALLBACK_SPLIT_COUNTS;
  try {
    const parsed = JSON.parse(fs.readFileSync(
      splitsPath(repositoryRoot),
      'utf8',
    )) as Record<string, unknown>;
    const count = (key: 'heldIn' | 'heldOut' | 'safety', fallback: number): number => (
      Array.isArray(parsed[key]) ? parsed[key].length : fallback
    );
    return {
      'held-in': count('heldIn', FALLBACK_SPLIT_COUNTS['held-in']),
      'held-out': count('heldOut', FALLBACK_SPLIT_COUNTS['held-out']),
      safety: count('safety', FALLBACK_SPLIT_COUNTS.safety),
    };
  } catch {
    return FALLBACK_SPLIT_COUNTS;
  }
}

export async function inspectEvalRunPanel(): Promise<EvalRunPanelProbe> {
  const environment = inspectEvalEnvironment();
  const model = resolveSessionDefaultModelConfig();
  const judge = getQuickModelRuntimeInfo();
  const judgeIdentity = judge ? `${judge.provider}/${judge.model}` : 'unavailable';
  const registryDir = path.join(environment.repositoryRoot ?? '', CONFIG_DIR_NEW);
  const aiReview = AI_REVIEW_DIMENSION_DEFINITIONS.map(({ id, requiresExpectation }) => {
    const record = loadCalibrationRecordSync(registryDir, `${id}@${judgeIdentity}`);
    const details = record ? {
      kappa: record.kappa,
      pairs: record.pairs,
      computedAt: record.computedAt,
      ...(record.standardVersion === 2 ? { goldSource: record.goldSource } : {}),
    } : {};
    let reason: EvalRunPanelProbe['aiReview'][number]['calibration']['reason'];
    if (!record) reason = 'no_record';
    else if (record.standardVersion !== 2) reason = 'superseded';
    else if (record.promptHash !== getAiReviewPromptHash(id)) reason = 'prompt_changed';
    else if (judge && (record.endpoint !== judge.baseUrl || record.judgeModel !== judgeIdentity)) reason = 'judge_changed';
    else if (record.pairs < CALIBRATION_TRUST_THRESHOLDS.minPairs) reason = 'not_enough_pairs';
    else if (!isTrustedCalibration(record)) reason = 'below_threshold';
    return {
      dim: id,
      requiresExpectation,
      calibration: reason
        ? { state: 'uncalibrated' as const, reason, ...details }
        : { state: 'calibrated' as const, ...details },
    };
  });
  const productionArm = buildProductionCompareArm({ model: model.model, provider: model.provider });
  const skills = Array.from(new Set([
    ...(productionArm.skills ?? []),
    ...getSkillDiscoveryService().getAllSkills().map((skill) => skill.name),
  ])).sort((left, right) => left.localeCompare(right));
  const caseBank = environment.repositoryRoot
    ? await enumerateCaseBank(environment.repositoryRoot)
    : [];
  const unhardenedCount = caseBank.filter(
    (item) => !('parseError' in item) && !item.hardened,
  ).length;
  return {
    environment: {
      available: environment.available,
      message: environment.message,
      packaged: environment.packaged,
      platform: environment.platform,
      osJail: environment.osJail,
    },
    model: model.model,
    provider: model.provider,
    priceTableVersion: PRICING_TABLE_VERSION,
    estimatedCostPerCaseUsd: estimateEvalCostPerCase(model.model),
    judge: {
      model: judge?.model ?? 'unavailable',
      provider: judge?.provider ?? 'unavailable',
      estimatedCostPerCaseUsd: estimateEvalCostPerCase(judge?.model ?? 'default'),
    },
    aiReview,
    splitCounts: readSplitCounts(environment.repositoryRoot),
    unhardenedCount,
    // 「快速检查」是 core-path 标签下最多取 12 题，不创建第四个评测集桶。
    quickCheck: { tags: ['core-path'], maxCases: 12 },
    productionArm,
    skills,
  };
}
