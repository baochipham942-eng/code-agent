// ============================================================================
// Evaluation IPC Handlers - evaluation:* 通道（GAP-017 Harness 对照实验）
// 固定模型、变 harness 配置（context 压缩 / 工具集 / hooks）的对照实验入口。
// webServer 会把这些 channel 自动暴露为 POST /api/evaluation/<action>。
// 2026-07-27 评测中心 v2：新增 LOAD_EXPERIMENT 只读查询（实验 + 用例行，
// 裁剪 data_json），与 LIST_EXPERIMENTS 一起支撑「基准」tab 的回归对比。
// ============================================================================

import type { IpcMain } from '@host/platform';
import { EVALUATION_CHANNELS } from '../../shared/evaluationChannels';
import { createLogger } from '@host/services/infra/logger';
import { getChannelAccessIpcError, registerAdminChannels } from '@host/ipc/channelAccessPolicy';
import { enumerateCaseBank, saveCaseBank } from '../testing/caseBank';
import type { SaveEvalCaseRequest } from '@shared/contract/evaluation';
import { getEvalRunBridge, type EvalRunBridge } from '../evaluation/evalRunBridge';
import { inspectEvalEnvironment } from '../evaluation/evalEnvironment';
import { inspectEvalRunPanel } from '../evaluation/evalRunPanelProbe';
import { EXPECTATION_TYPE_CATALOG } from '@host/testing/expectationCatalog';

const logger = createLogger('EvaluationIPC');

/**
 * 注册评测实验相关 IPC handlers
 */
export function registerEvaluationHandlers(
  ipcMain: IpcMain,
  runBridge: EvalRunBridge = getEvalRunBridge(),
): void {
  registerAdminChannels(Object.values(EVALUATION_CHANNELS));
  ipcMain.handle(EVALUATION_CHANNELS.RUN_SUITE, async (_event, payload: unknown) => {
    const denied = getChannelAccessIpcError(EVALUATION_CHANNELS.RUN_SUITE, 'Evaluation run');
    if (denied) return denied;
    try {
      return await runBridge.startRun(payload);
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'EVAL_RUN_REJECTED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });

  ipcMain.handle(EVALUATION_CHANNELS.RUN_EVENTS, async (_event, payload?: { runId?: string }) => {
    const denied = getChannelAccessIpcError(EVALUATION_CHANNELS.RUN_EVENTS, 'Evaluation events');
    if (denied) return denied;
    if (!payload?.runId) return inspectEvalRunPanel();
    return runBridge.subscribe(payload.runId);
  });

  ipcMain.handle(EVALUATION_CHANNELS.ABORT_RUN, async (_event, payload?: { runId?: string }) => {
    const denied = getChannelAccessIpcError(EVALUATION_CHANNELS.ABORT_RUN, 'Evaluation abort');
    if (denied) return denied;
    if (!payload?.runId) throw new Error('runId is required');
    return runBridge.abortRun(payload.runId);
  });

  ipcMain.handle(EVALUATION_CHANNELS.SCORERS_OVERVIEW, async () => {
    const denied = getChannelAccessIpcError(EVALUATION_CHANNELS.SCORERS_OVERVIEW, 'Evaluation scorers');
    if (denied) return denied;
    const probe = inspectEvalRunPanel();
    return { assertions: EXPECTATION_TYPE_CATALOG, aiReview: probe.aiReview, judge: probe.judge };
  });

  ipcMain.handle(EVALUATION_CHANNELS.LIST_CASES, async () => {
    const denied = getChannelAccessIpcError(EVALUATION_CHANNELS.LIST_CASES, 'Evaluation case bank');
    if (denied) return denied;
    return enumerateCaseBank(requireRepositoryRoot());
  });

  ipcMain.handle(EVALUATION_CHANNELS.SAVE_CASE, async (_event, payload: SaveEvalCaseRequest) => {
    const denied = getChannelAccessIpcError(EVALUATION_CHANNELS.SAVE_CASE, 'Evaluation case bank write');
    if (denied) return denied;
    return saveCaseBank(requireRepositoryRoot(), payload);
  });

  // 列出已落 DB 的实验（含 harness 维度），供对比与轮询
  ipcMain.handle(
    EVALUATION_CHANNELS.LIST_EXPERIMENTS,
    async (_event, payload?: { limit?: number; source?: 'compare' | 'eval' }) => {
      const { getDatabase } = await import('@host/services/core/databaseService');
      const db = getDatabase();
      const experiments = db.listExperiments(payload?.limit ?? 50)
        .filter((experiment) => payload?.source === undefined
          || (payload.source === 'compare' ? experiment.source === 'compare' : experiment.source !== 'compare'));
      return experiments.map((experiment) => ({
        ...experiment,
        // 契约字段（EvalExperimentListItem）：camelCase + 解析后的 summary
        gitCommit: experiment.git_commit,
        // 解析 config_json 方便调用方直接读 harness 维度
        config: safeParseJsonRecord(experiment.config_json),
        summary: safeParseJson(experiment.summary_json),
      }));
    },
  );

  // 只读加载单个实验 + 用例行（评测中心「基准」tab 最近两次回归对比）。
  // 刻意裁剪 data_json（含 qualityReport/trials 等大字段），只回对比所需的最小面。
  ipcMain.handle(
    EVALUATION_CHANNELS.LOAD_EXPERIMENT,
    async (_event, experimentId: string) => {
      if (!experimentId || typeof experimentId !== 'string') {
        throw new Error('experimentId is required');
      }
      const { getDatabase } = await import('@host/services/core/databaseService');
      const db = getDatabase();
      const loaded = db.loadExperiment(experimentId);
      if (!loaded) return null;
      const { experiment, cases } = loaded;
      return {
        experiment: {
          id: experiment.id,
          name: experiment.name,
          timestamp: experiment.timestamp,
          model: experiment.model,
          provider: experiment.provider,
          scope: experiment.scope,
          source: experiment.source,
          gitCommit: experiment.git_commit,
          config: safeParseJsonRecord(experiment.config_json),
          summary: safeParseJson(experiment.summary_json),
        },
        cases: cases.map((c) => ({
          caseId: c.case_id,
          status: c.status,
          score: c.score,
          durationMs: c.duration_ms,
          data: pickExperimentCaseData(safeParseJsonRecord(c.data_json)),
        })),
      };
    },
  );

  logger.info('Evaluation handlers registered', {
    channels: Object.values(EVALUATION_CHANNELS),
  });
}

function pickExperimentCaseData(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  const keys = [
    'assignment', 'statusA', 'statusB', 'winner', 'referenceWinner', 'excludedReason',
    'assertionPassA', 'assertionPassB', 'assertionCount', 'skillActivations',
  ];
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

function requireRepositoryRoot(): string {
  const repositoryRoot = inspectEvalEnvironment().repositoryRoot;
  if (!repositoryRoot) throw new Error('找不到评测题库所在的仓库');
  return repositoryRoot;
}

function safeParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeParseJsonRecord(raw: string | null): Record<string, unknown> | null {
  const value = safeParseJson(raw);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
