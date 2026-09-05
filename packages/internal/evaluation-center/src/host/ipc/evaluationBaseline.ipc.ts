import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IpcMain } from '@host/platform';
import { getChannelAccessIpcError } from '@host/ipc/channelAccessPolicy';
import { getAuthService } from '@host/services/auth/authService';
import { getDatabase } from '@host/services/core/databaseService';
import {
  BaselineManager,
  BaselinePromotionError,
} from '@host/testing/ci/baselineManager';
import type { EvalBaseline, TestRunSummary, TestStatus } from '@host/testing/types';
import type {
  EvalBaselineGroupKey,
  EvalBaselineInfo,
  EvalBaselineInfoResult,
  EvalBaselineSetError,
  EvalBaselineSetResult,
  EvalBaselineSplit,
  RunShape,
} from '@shared/contract/evaluationBaseline';
import { inspectEvalEnvironment } from '../evaluation/evalEnvironment';
import { EVALUATION_CHANNELS } from '../../shared/evaluationChannels';

const BASELINE_FILE = /^eval-baseline\.(held-in|held-out|safety|all)\.k([1-9]\d*)\.json$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return record(JSON.parse(raw));
  } catch {
    return null;
  }
}

function baselineInfo(baseline: EvalBaseline): EvalBaselineInfo {
  return {
    ...(baseline.experimentId ? { experimentId: baseline.experimentId } : {}),
    updatedAt: baseline.updatedAt,
    updatedBy: baseline.updatedBy,
    commit: baseline.commit ?? baseline.updatedBy,
    caseBankSha: baseline.caseBankSha ?? 'unknown',
    aggregationRuleVersion: baseline.aggregationRuleVersion ?? 0,
    denominatorVersion: baseline.denominatorVersion ?? 0,
    divergesFromProduction: baseline.divergesFromProduction ?? false,
    productionDifferences: baseline.productionDifferences ?? [],
    ...(baseline.shape ? { shape: baseline.shape } : {}),
    plannedCaseIds: baseline.plannedCaseIds ?? [],
    caseResults: Object.fromEntries(Object.entries(baseline.caseResults).map(([caseId, result]) => [
      caseId,
      { status: result.status, score: result.score },
    ])),
  };
}

function repositoryRoot(): string {
  const root = inspectEvalEnvironment().repositoryRoot;
  if (!root) throw new Error('找不到评测题库所在的仓库');
  return root;
}

function currentUserId(): string {
  try {
    return getAuthService().getCurrentUser()?.id ?? 'local';
  } catch {
    return 'local';
  }
}

function splitFromConfig(config: Record<string, unknown>): EvalBaselineSplit | null {
  const evalSet = record(config.evalSet);
  const value = typeof config.split === 'string' ? config.split : evalSet?.split;
  return value === 'held-in' || value === 'held-out' || value === 'safety' || value === 'all'
    ? value
    : null;
}

function status(value: string): TestStatus {
  if (value === 'passed' || value === 'failed' || value === 'skipped' || value === 'partial'
    || value === 'infra_excluded' || value === 'cost_exceeded' || value === 'not_run') return value;
  return 'failed';
}

function legacyOrInvalidConfig(
  config: Record<string, unknown> | null,
  summary: Record<string, unknown> | null,
): EvalBaselineSetError | null {
  if (!config || !summary || !Array.isArray(summary.plannedCaseIds)) return 'baseline_legacy_run';
  if (config.mode !== 'real') return config.mode === undefined ? 'baseline_legacy_run' : 'baseline_not_real';
  if (!splitFromConfig(config) || typeof config.k !== 'number' || typeof config.caseBankSha !== 'string') {
    return 'baseline_legacy_run';
  }
  if (typeof summary.aggregationRuleVersion !== 'number') return 'baseline_legacy_run';
  return null;
}

async function setBaseline(experimentId: string): Promise<EvalBaselineSetResult> {
  const loaded = getDatabase().loadExperiment(experimentId);
  if (!loaded) return { error: 'baseline_legacy_run' };
  const config = parseRecord(loaded.experiment.config_json);
  const storedSummary = parseRecord(loaded.experiment.summary_json);
  const configError = legacyOrInvalidConfig(config, storedSummary);
  if (configError || !config || !storedSummary) return { error: configError ?? 'baseline_legacy_run' };
  const split = splitFromConfig(config);
  if (!split) return { error: 'baseline_legacy_run' };
  const plannedCaseIds = (storedSummary.plannedCaseIds as unknown[])
    .filter((id): id is string => typeof id === 'string');
  const invalidCases = typeof storedSummary.invalidCases === 'number' ? storedSummary.invalidCases : 0;
  if (invalidCases > 0) return { error: 'baseline_invalid_run' };
  const results = loaded.cases.map((item) => ({
    testId: item.case_id,
    status: status(item.status),
    score: item.score,
    startTime: loaded.experiment.timestamp,
    endTime: loaded.experiment.timestamp + (item.duration_ms ?? 0),
    duration: item.duration_ms ?? 0,
  }));
  const completed = storedSummary.completed !== false
    && (storedSummary.notRun ?? 0) === 0
    && plannedCaseIds.every((id) => results.some((result) => result.testId === id));
  const shape = record(config.shape) as RunShape | null;
  const differences = Array.isArray(config.divergesFromProduction)
    ? config.divergesFromProduction.filter((item): item is string => typeof item === 'string')
    : [];
  const summary = {
    runId: experimentId,
    startTime: loaded.experiment.timestamp,
    endTime: loaded.experiment.timestamp,
    duration: typeof storedSummary.duration === 'number' ? storedSummary.duration : 0,
    total: plannedCaseIds.length,
    plannedCaseIds,
    completed,
    passed: typeof storedSummary.passed === 'number' ? storedSummary.passed : 0,
    failed: typeof storedSummary.failed === 'number' ? storedSummary.failed : 0,
    skipped: typeof storedSummary.skipped === 'number' ? storedSummary.skipped : 0,
    partial: typeof storedSummary.partial === 'number' ? storedSummary.partial : 0,
    notRun: typeof storedSummary.notRun === 'number' ? storedSummary.notRun : 0,
    invalidCases,
    averageScore: typeof storedSummary.avgScore === 'number' ? storedSummary.avgScore : 0,
    results,
    environment: {
      model: loaded.experiment.model ?? 'unknown',
      provider: loaded.experiment.provider ?? 'unknown',
      workingDirectory: repositoryRoot(),
    },
    stamp: {
      caseBankSha: config.caseBankSha as string,
      shape: shape ?? { skills: [], plugins: [], memory: false, swarm: false, harness: null },
      divergesFromProduction: differences,
    },
    aggregationRule: storedSummary.aggregationRule,
    aggregationRuleVersion: storedSummary.aggregationRuleVersion,
    performance: { avgResponseTime: 0, maxResponseTime: 0, totalToolCalls: 0, totalTurns: 0 },
  } as TestRunSummary;
  const manager = new BaselineManager(repositoryRoot(), { group: { split, k: config.k as number } });
  try {
    await manager.promote(
      summary,
      loaded.experiment.git_commit ?? 'unknown',
      'real',
      plannedCaseIds,
      {
        experimentId,
        updatedBy: currentUserId(),
        caseBankSha: config.caseBankSha as string,
        ...(shape ? { shape } : {}),
        productionDifferences: differences,
      },
    );
  } catch (error) {
    if (error instanceof BaselinePromotionError) return { error: error.code };
    throw error;
  }
  const baseline = await manager.load();
  if (!baseline) throw new Error('对比基准写入后无法读回');
  return { baseline: baselineInfo(baseline) };
}

async function loadBaselineGroups(): Promise<EvalBaselineInfoResult> {
  const root = repositoryRoot();
  const dir = path.join(root, '.claude');
  const groups: EvalBaselineInfoResult['groups'] = {};
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return { groups };
  }
  await Promise.all(files.map(async (file) => {
    const match = BASELINE_FILE.exec(file);
    if (!match) return;
    const split = match[1] as EvalBaselineSplit;
    const k = Number(match[2]);
    const baseline = await new BaselineManager(root, { group: { split, k } }).load();
    if (baseline) groups[`${split}::${k}` as EvalBaselineGroupKey] = baselineInfo(baseline);
  }));
  return { groups };
}

export function registerEvaluationBaselineHandlers(ipcMain: IpcMain): string[] {
  ipcMain.handle(EVALUATION_CHANNELS.SET_BASELINE, async (_event, payload?: { experimentId?: string }) => {
    const denied = getChannelAccessIpcError(EVALUATION_CHANNELS.SET_BASELINE, 'Evaluation baseline write');
    if (denied) return denied;
    if (!payload?.experimentId || typeof payload.experimentId !== 'string') {
      return { error: 'baseline_legacy_run' } satisfies EvalBaselineSetResult;
    }
    return setBaseline(payload.experimentId);
  });
  ipcMain.handle(EVALUATION_CHANNELS.BASELINE_INFO, async () => {
    const denied = getChannelAccessIpcError(EVALUATION_CHANNELS.BASELINE_INFO, 'Evaluation baseline read');
    if (denied) return denied;
    return loadBaselineGroups();
  });
  return [EVALUATION_CHANNELS.SET_BASELINE, EVALUATION_CHANNELS.BASELINE_INFO];
}
