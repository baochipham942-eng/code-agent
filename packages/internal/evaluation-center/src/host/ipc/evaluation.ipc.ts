// ============================================================================
// Evaluation IPC Handlers - evaluation:* 通道（GAP-017 Harness 对照实验）
// 固定模型、变 harness 配置（context 压缩 / 工具集 / hooks）的对照实验入口。
// webServer 会把这些 channel 自动暴露为 POST /api/evaluation/<action>。
// 2026-07-27 评测中心 v2：新增 LOAD_EXPERIMENT 只读查询（实验 + 用例行，
// 裁剪 data_json），与 LIST_EXPERIMENTS 一起支撑「基准」tab 的回归对比。
// ============================================================================

import { randomUUID } from 'crypto';
import type { IpcMain } from '@host/platform';
import { EVALUATION_CHANNELS } from '../../shared/evaluationChannels';
import { createLogger } from '@host/services/infra/logger';
import { getChannelAccessIpcError, registerAdminChannels } from '@host/ipc/channelAccessPolicy';
import { enumerateCaseBank, saveCaseBank } from '../testing/caseBank';
import type {
  AiReviewDimension,
  EvalAnnotation,
  EvalCaseListEntry,
  EvalExperimentCaseDetail,
  ListEvalAnnotationsResult,
  SaveEvalAnnotationRequest,
  SaveEvalAnnotationResult,
  SaveEvalCaseRequest,
} from '@shared/contract/evaluation';
import { getEvalRunBridge, type EvalRunBridge } from '../evaluation/evalRunBridge';
import { inspectEvalEnvironment } from '../evaluation/evalEnvironment';
import { inspectEvalRunPanel } from '../evaluation/evalRunPanelProbe';
import { EXPECTATION_TYPE_CATALOG } from '@host/testing/expectationCatalog';
import { failureCodeLabel, loadProjectFailureCodebook } from '@host/testing/failureCodes';
import { buildEvalExperimentCaseDetail } from '../evaluation/evalCaseDetail';
import { getAuthService } from '@host/services/auth/authService';
import { assertAiReviewDimensionsComplete, isAiReviewDimension } from '@host/testing/judge/dimensions';
import type { AnnotationRow } from '@host/services/core/databaseService';

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

  ipcMain.handle(
    EVALUATION_CHANNELS.LOAD_CASE,
    async (_event, payload?: { experimentId?: string; caseId?: string }) => {
      const denied = getChannelAccessIpcError(EVALUATION_CHANNELS.LOAD_CASE, 'Evaluation case evidence');
      if (denied) return denied;
      if (!payload?.experimentId || typeof payload.experimentId !== 'string') {
        throw new Error('experimentId is required');
      }
      if (!payload.caseId || typeof payload.caseId !== 'string') throw new Error('caseId is required');
      const { getDatabase } = await import('@host/services/core/databaseService');
      const loaded = getDatabase().loadExperimentCase(payload.experimentId, payload.caseId);
      if (!loaded) return null;
      const data = safeParseJsonRecord(loaded.data_json) ?? {};
      const failure = data.failure as EvalExperimentCaseDetail['failure'] | undefined;
      const context = await loadOptionalCaseContext(payload.caseId, failure);
      return buildEvalExperimentCaseDetail({
        row: loaded,
        assertionCatalog: EXPECTATION_TYPE_CATALOG,
        ...context,
      });
    },
  );

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

  ipcMain.handle(EVALUATION_CHANNELS.SAVE_ANNOTATION, async (_event, payload: SaveEvalAnnotationRequest) => {
    const denied = getChannelAccessIpcError(EVALUATION_CHANNELS.SAVE_ANNOTATION, 'Evaluation annotation write');
    if (denied) return denied;
    const request = validateAnnotationRequest(payload);
    const { getDatabase } = await import('@host/services/core/databaseService');
    const db = getDatabase();
    if (!db.loadExperimentCase(request.experimentId, request.caseId)) {
      throw new Error('Evaluation case does not exist');
    }
    const reviewerId = currentReviewerId();
    const existing = db.listAnnotationsForCase(request.experimentId, request.caseId);
    if (request.supersedesId) {
      const superseded = existing.find((row) => row.id === request.supersedesId);
      if (!superseded || superseded.reviewer_id !== reviewerId) {
        throw new Error('supersedesId must belong to this case and reviewer');
      }
    }
    const row: AnnotationRow = {
      id: randomUUID(),
      experiment_id: request.experimentId,
      case_id: request.caseId,
      reviewer_id: reviewerId,
      overall: request.overall ?? null,
      note: request.note ?? null,
      dims_json: JSON.stringify(request.dims),
      consent_scope: 'metadata',
      calibration_split: null,
      supersedes_id: request.supersedesId ?? null,
      created_at: Date.now(),
    };
    db.insertAnnotation(row);
    return { annotation: annotationFromRow(row, reviewerId) } satisfies SaveEvalAnnotationResult;
  });

  ipcMain.handle(
    EVALUATION_CHANNELS.LIST_ANNOTATIONS,
    async (_event, payload?: { experimentId?: string; caseId?: string }) => {
      const denied = getChannelAccessIpcError(EVALUATION_CHANNELS.LIST_ANNOTATIONS, 'Evaluation annotations');
      if (denied) return denied;
      const experimentId = requireNonEmptyString(payload?.experimentId, 'experimentId');
      const caseId = requireNonEmptyString(payload?.caseId, 'caseId');
      const { getDatabase } = await import('@host/services/core/databaseService');
      const db = getDatabase();
      if (!db.loadExperimentCase(experimentId, caseId)) throw new Error('Evaluation case does not exist');
      const reviewerId = currentReviewerId();
      const annotations = db.listAnnotationsForCase(experimentId, caseId)
        .map((row) => annotationFromRow(row, reviewerId));
      const seen = new Set<string>();
      const latestByReviewer = annotations.filter((annotation) => {
        if (seen.has(annotation.reviewerId)) return false;
        seen.add(annotation.reviewerId);
        return true;
      });
      return { annotations, latestByReviewer } satisfies ListEvalAnnotationsResult;
    },
  );

  // 列出已落 DB 的实验（含 harness 维度），供对比与轮询
  ipcMain.handle(
    EVALUATION_CHANNELS.LIST_EXPERIMENTS,
    async (_event, payload?: { limit?: number }) => {
      const { getDatabase } = await import('@host/services/core/databaseService');
      const db = getDatabase();
      const experiments = db.listExperiments(payload?.limit ?? 50);
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

function validateAnnotationRequest(payload: unknown): SaveEvalAnnotationRequest {
  assertAiReviewDimensionsComplete();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Annotation request is required');
  }
  const value = payload as Record<string, unknown>;
  const experimentId = requireNonEmptyString(value.experimentId, 'experimentId');
  const caseId = requireNonEmptyString(value.caseId, 'caseId');
  if (value.overall !== undefined && value.overall !== 'up' && value.overall !== 'down') {
    throw new Error('overall must be up or down');
  }
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 2000)) {
    throw new Error('note must be a string no longer than 2000 characters');
  }
  if (!value.dims || typeof value.dims !== 'object' || Array.isArray(value.dims)) {
    throw new Error('dims must be an object');
  }
  const dims: Partial<Record<AiReviewDimension, 'yes' | 'no'>> = {};
  for (const [dimension, verdict] of Object.entries(value.dims)) {
    if (!isAiReviewDimension(dimension) || (verdict !== 'yes' && verdict !== 'no')) {
      throw new Error('dims contains an unknown dimension or verdict');
    }
    dims[dimension] = verdict;
  }
  const supersedesId = value.supersedesId === undefined
    ? undefined
    : requireNonEmptyString(value.supersedesId, 'supersedesId');
  return {
    experimentId,
    caseId,
    dims,
    ...(value.overall === 'up' || value.overall === 'down' ? { overall: value.overall } : {}),
    ...(typeof value.note === 'string' ? { note: value.note } : {}),
    ...(supersedesId ? { supersedesId } : {}),
  };
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function currentReviewerId(): string {
  try {
    return getAuthService().getCurrentUser()?.id ?? 'local';
  } catch {
    return 'local';
  }
}

function annotationFromRow(row: AnnotationRow, reviewerId: string): EvalAnnotation {
  const dims = safeParseJsonRecord(row.dims_json) ?? {};
  return {
    id: row.id,
    experimentId: row.experiment_id,
    caseId: row.case_id,
    reviewerId: row.reviewer_id,
    ...(row.overall ? { overall: row.overall } : {}),
    ...(row.note !== null ? { note: row.note } : {}),
    dims: dims as Partial<Record<AiReviewDimension, 'yes' | 'no'>>,
    consentScope: row.consent_scope,
    ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
    createdAt: row.created_at,
    mine: row.reviewer_id === reviewerId,
  };
}

async function loadOptionalCaseContext(
  caseId: string,
  failure: EvalExperimentCaseDetail['failure'] | undefined,
): Promise<{ failureLabel?: string; caseMetadata?: EvalCaseListEntry }> {
  const repositoryRoot = inspectEvalEnvironment().repositoryRoot;
  if (!repositoryRoot) return {};
  try {
    const bankItem = (await enumerateCaseBank(repositoryRoot)).find(
      (item): item is EvalCaseListEntry => item.id === caseId && !('parseError' in item),
    );
    return {
      ...(failure ? {
        failureLabel: failureCodeLabel(loadProjectFailureCodebook(repositoryRoot), failure.code),
      } : {}),
      ...(bankItem ? { caseMetadata: bankItem } : {}),
    };
  } catch (error) {
    logger.warn('Optional evaluation case context unavailable', {
      caseId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
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
