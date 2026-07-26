// ============================================================================
// Evaluation IPC Handlers - evaluation:* 通道（GAP-017 Harness 对照实验）
// 固定模型、变 harness 配置（context 压缩 / 工具集 / hooks）的对照实验入口。
// webServer 会把这些 channel 自动暴露为 POST /api/evaluation/<action>。
// 2026-07-27 评测中心 v2：新增 LOAD_EXPERIMENT 只读查询（实验 + 用例行，
// 裁剪 data_json），与 LIST_EXPERIMENTS 一起支撑「基准」tab 的回归对比。
// ============================================================================

import type { IpcMain } from '../platform';
import { EVALUATION_CHANNELS } from '../../shared/ipc/channels';
import { createLogger } from '../services/infra/logger';
import type { HarnessVariantConfig } from '../testing/types';

const logger = createLogger('EvaluationIPC');

interface RunHarnessComparisonPayload {
  model: string;
  provider: string;
  apiKey?: string;
  variants: HarnessVariantConfig[];
  workingDirectory?: string;
  testCaseDir?: string;
  filterTags?: string[];
  filterIds?: string[];
  maxIterations?: number;
  defaultTimeout?: number;
}

/**
 * 注册评测实验相关 IPC handlers
 */
export function registerEvaluationHandlers(ipcMain: IpcMain): void {
  // 启动 harness 对照实验（fire-and-forget：先返回预生成的 runId，结果落 DB 后可查）
  ipcMain.handle(
    EVALUATION_CHANNELS.RUN_HARNESS_COMPARISON,
    async (_event, payload: RunHarnessComparisonPayload) => {
      if (!payload?.model || !payload?.provider) {
        throw new Error('model and provider are required');
      }
      if (!Array.isArray(payload.variants) || payload.variants.length < 2) {
        throw new Error('At least 2 harness variants are required for a comparison');
      }

      const { runHarnessComparison, buildVariantRunIds } = await import('../testing/harnessComparison');

      const workingDirectory = payload.workingDirectory
        || process.env.CODE_AGENT_WORKING_DIR
        || process.cwd();
      const runIds = buildVariantRunIds(payload.variants);

      // 异步执行：每个变体完成后由 TestRunner 内部落 DB
      runHarnessComparison(
        {
          model: payload.model,
          provider: payload.provider,
          apiKey: payload.apiKey,
          variants: payload.variants,
          workingDirectory,
          testCaseDir: payload.testCaseDir,
          filterTags: payload.filterTags,
          filterIds: payload.filterIds,
          maxIterations: payload.maxIterations,
          defaultTimeout: payload.defaultTimeout,
        },
        runIds,
      ).catch((error) => {
        logger.error('Harness comparison failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      return {
        status: 'started',
        runs: payload.variants.map((variant) => ({
          variant: variant.name,
          runId: runIds.get(variant.name),
        })),
      };
    },
  );

  // 列出已落 DB 的实验（含 harness 维度），供对比与轮询
  ipcMain.handle(
    EVALUATION_CHANNELS.LIST_EXPERIMENTS,
    async (_event, payload?: { limit?: number }) => {
      const { getDatabase } = await import('../services/core/databaseService');
      const db = getDatabase();
      const experiments = db.listExperiments(payload?.limit ?? 50);
      return experiments.map((experiment) => ({
        ...experiment,
        // 契约字段（EvalExperimentListItem）：camelCase + 解析后的 summary
        gitCommit: experiment.git_commit,
        // 解析 config_json 方便调用方直接读 harness 维度
        config: safeParseJson(experiment.config_json),
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
      const { getDatabase } = await import('../services/core/databaseService');
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
          summary: safeParseJson(experiment.summary_json),
        },
        cases: cases.map((c) => ({
          caseId: c.case_id,
          status: c.status,
          score: c.score,
          durationMs: c.duration_ms,
        })),
      };
    },
  );

  logger.info('Evaluation handlers registered', {
    channels: Object.values(EVALUATION_CHANNELS),
  });
}

function safeParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
