// ============================================================================
// 从会话转成题目 —— 预览编排（宿主侧）
// ----------------------------------------------------------------------------
// 拉数据（结构化回放 / 会话工作目录 / 点踩时刻）→ 交给 harvestCandidates 的纯
// 函数推候选。这里只做取数与失败隔离：一场会话取不到不炸整批，如实回报。
// ============================================================================

import type {
  HarvestDraftSeed,
  HarvestFieldKey,
  HarvestPreviewRequest,
  HarvestPreviewResult,
  StructuredReplay,
} from '@shared/contract/evaluation';
import type { PostLaunchConsentScope, PostLaunchReflowCandidate } from '@shared/contract/postLaunchScore';
import { HARVEST_LOCKED_FIELDS } from '@shared/contract/evaluation';
import { deriveHarvestSeed } from './harvestCandidates';
import { queryNegativeFeedback } from './trajectoryToCase';
import { isPostLaunchReflowEnabled } from '@host/testing/postlaunch/postLaunchGate';
import { getPostLaunchConsentScope, listReflowCandidates } from '@host/testing/postlaunch/postLaunchScoreStore';

/** 一次最多收多少场：模态本来就是人手选的量级，超出直接拒，不做分页。 */
const HARVEST_MAX_SESSIONS = 20;
/** 单场会话读多少条点踩：反向候选只需要少量锚点。 */
const NEGATIVE_FEEDBACK_LIMIT = 10;

function turnHasUserPrompt(turn: NonNullable<StructuredReplay['turns']>[number]): boolean {
  return (turn.blocks ?? []).some((block) => block.type === 'user' && block.content.trim());
}

function isTriggerTurn(turn: NonNullable<StructuredReplay['turns']>[number], turnId: string): boolean {
  return String(turn.turnNumber) === String(turnId) || turn.parentTurnId === turnId;
}

/**
 * 按保存时的同意档裁剪回放。full_session 不裁；turn_excerpt（及更低档）只留触发轮
 * 及其直接上下文（触发轮本身 + 往前最近一条带用户原话的轮），不得带上更早轮的原文。
 */
export function scopeReplayToCandidate(
  replay: StructuredReplay,
  candidates: readonly PostLaunchReflowCandidate[],
  consentScope: PostLaunchConsentScope,
): StructuredReplay {
  if (consentScope === 'full_session') return replay;
  const match = candidates.find((candidate) => candidate.sessionId === replay.sessionId && candidate.turnId);
  if (!match?.turnId) return replay;
  const turns = replay.turns ?? [];
  const index = turns.findIndex((turn) => isTriggerTurn(turn, match.turnId!));
  if (index < 0) return replay;
  let userIndex = -1;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (turnHasUserPrompt(turns[cursor])) {
      userIndex = cursor;
      break;
    }
  }
  const start = userIndex >= 0 ? userIndex : index;
  return { ...replay, turns: turns.slice(start, index + 1) };
}

function harvestBatchTag(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `harvest-${month}${day}`;
}

function normalizeRequest(payload: HarvestPreviewRequest): { sessionIds: string[]; fields: HarvestFieldKey[]; postLaunchReflow: boolean } {
  const rawIds = Array.isArray(payload?.sessionIds) ? payload.sessionIds : [];
  const sessionIds = [...new Set(
    rawIds.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean),
  )];
  if (sessionIds.length === 0) throw new Error('请先选择至少一场会话');
  if (sessionIds.length > HARVEST_MAX_SESSIONS) {
    throw new Error(`一次最多转换 ${HARVEST_MAX_SESSIONS} 场会话`);
  }
  const rawFields = Array.isArray(payload?.fields) ? payload.fields : [];
  // 锁定行（用户原话 / 来源会话 id）无论前端传没传都算勾上——来源必须留。
  const fields = [...new Set([...HARVEST_LOCKED_FIELDS, ...rawFields])] as HarvestFieldKey[];
  return { sessionIds, fields, postLaunchReflow: payload.postLaunchReflow === true };
}

/** 将候选的结构化触发原因写入 HARVEST 草稿，不带回复/工具正文。 */
export function applyPostLaunchReflowProvenance(
  seed: HarvestDraftSeed,
  candidates: readonly PostLaunchReflowCandidate[],
): HarvestDraftSeed {
  const matches = candidates.filter((candidate) => candidate.sessionId === seed.sessionId);
  if (matches.length === 0) throw new Error('这场会话没有可回流的候选');
  const sources = [...new Set(matches.flatMap((candidate) => candidate.sources))];
  const redDimensions = [...new Set(matches.flatMap((candidate) => candidate.redDimensions))];
  const signals = [...new Set(matches.flatMap((candidate) => candidate.signals))];
  const trigger = [
    ...sources.map((source) => `source:${source}`),
    ...redDimensions.map((dimension) => `red:${dimension}`),
    ...signals.map((signal) => `signal:${signal}`),
  ];
  return {
    ...seed,
    tags: [...new Set([...seed.tags, 'postlaunch', ...trigger])],
    description: `${seed.description}；上线后回流触发：${trigger.join('、')}`,
    postLaunchReflow: {
      turnId: matches.find((candidate) => candidate.turnId)?.turnId ?? null,
      sources,
      redDimensions,
      signals,
    },
  };
}

export async function buildHarvestPreview(payload: HarvestPreviewRequest): Promise<HarvestPreviewResult> {
  const { sessionIds, fields, postLaunchReflow } = normalizeRequest(payload);
  if (postLaunchReflow && !isPostLaunchReflowEnabled()) {
    throw new Error('上线后坏案例回流没开');
  }
  // 走宿主 SDK 表已暴露的 telemetryQueryService（同包 trajectoryExporter.ts:5 同一条路）。
  // replayService 只是它的 18 行 try/catch 包装，且不在 SDK 表里。
  const [{ getTelemetryQueryService }, { getDatabase }] = await Promise.all([
    import('@host/telemetry/replay/telemetryQueryService'),
    import('@host/services/core/databaseService'),
  ]);
  const database = getDatabase();
  const telemetry = getTelemetryQueryService();
  const db = database.getDb();
  const batchTag = harvestBatchTag();
  const seeds: HarvestDraftSeed[] = [];
  const failed: HarvestPreviewResult['failed'] = [];

  for (const sessionId of sessionIds) {
    try {
      const replay = await telemetry.getStructuredReplay(sessionId);
      if (!replay) throw new Error('这场会话没有可回放的记录');
      const session = database.getSession(sessionId);
      const sessionCandidates = postLaunchReflow && db
        ? listReflowCandidates(db, { sessionId, limit: 500 })
        : [];
      const consentScope = postLaunchReflow && db
        ? getPostLaunchConsentScope(db, sessionId)
        : 'full_session';
      const scopedReplay = postLaunchReflow
        ? scopeReplayToCandidate(replay, sessionCandidates, consentScope)
        : replay;
      let seed = deriveHarvestSeed({
        replay: scopedReplay,
        sessionTitle: session?.title?.trim() || sessionId,
        workingDirectory: session?.workingDirectory ?? '',
        fields,
        batchTag,
        negativeFeedbackAt: db
          ? queryNegativeFeedback(db, { limit: NEGATIVE_FEEDBACK_LIMIT, sessionId }).map((row) => row.createdAt)
          : [],
      });
      if (!seed.prompt) throw new Error('这场会话没有可用的用户原话');
      if (postLaunchReflow) {
        seed = applyPostLaunchReflowProvenance(seed, sessionCandidates);
      }
      seeds.push(seed);
    } catch (error) {
      failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { seeds, failed };
}
