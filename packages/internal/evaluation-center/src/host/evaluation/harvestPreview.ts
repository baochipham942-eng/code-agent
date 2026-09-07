// ============================================================================
// 从会话转成题目 —— 预览编排（宿主侧）
// ----------------------------------------------------------------------------
// 拉数据（结构化回放 / 会话工作目录 / 点踩时刻）→ 交给 harvestCandidates 的纯
// 函数推候选。这里只做取数与失败隔离：一场会话取不到不炸整批，如实回报。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type {
  HarvestDraftSeed,
  HarvestFieldKey,
  HarvestPreviewRequest,
  HarvestPreviewResult,
  StructuredReplay,
} from '@shared/contract/evaluation';
import type { PostLaunchConsentScope, PostLaunchReflowCandidate } from '@shared/contract/postLaunchScore';
import { HARVEST_LOCKED_FIELDS } from '@shared/contract/evaluation';
import { deriveHarvestSeed, resolveFeedbackTurn } from './harvestCandidates';
import { queryNegativeFeedback } from './trajectoryToCase';
import { isPostLaunchReflowEnabled } from '@host/testing/postlaunch/postLaunchGate';
import { getPostLaunchConsentScope, listReflowCandidates } from '@host/testing/postlaunch/postLaunchScoreStore';

/** 一次最多收多少场：模态本来就是人手选的量级，超出直接拒，不做分页。 */
const HARVEST_MAX_SESSIONS = 20;
/** 单场会话读多少条点踩：反向候选只需要少量锚点。 */
const NEGATIVE_FEEDBACK_LIMIT = 10;

/** telemetry_turns 行：用 id（UUID）对齐回放里的 turnNumber+startTime。 */
interface HarvestTurnRow {
  id: string;
  turn_number: number;
  start_time: number;
  turn_type: string;
  parent_turn_id: string | null;
}

export const REFLOW_TURN_MISMATCH_MESSAGE = '回流触发轮对不上回放记录';

type HarvestReplayTurns = NonNullable<StructuredReplay['turns']>;

function turnHasUserPrompt(turn: HarvestReplayTurns[number]): boolean {
  return (turn.blocks ?? []).some((block) => block.type === 'user' && block.content.trim());
}

function ownerRowOf(
  row: HarvestTurnRow,
  byId: Map<string, HarvestTurnRow>,
): HarvestTurnRow {
  if (row.turn_type === 'iteration' && row.parent_turn_id) {
    return byId.get(row.parent_turn_id) ?? row;
  }
  return row;
}

function replayIndexOfRow(turns: HarvestReplayTurns, row: HarvestTurnRow): number {
  return turns.findIndex((turn) => (
    turn.turnNumber === row.turn_number && turn.startTime === row.start_time
  ));
}

function turnBelongsToOwner(
  turn: HarvestReplayTurns[number],
  owner: HarvestTurnRow,
  row: HarvestTurnRow | undefined,
): boolean {
  if (row) {
    return row.id === owner.id || (row.turn_type === 'iteration' && row.parent_turn_id === owner.id);
  }
  return turn.turnType === 'iteration' && turn.parentTurnId === owner.id;
}

/**
 * 评分/信号候选：turnId 必须是 telemetry_turns.id，对不上 fail-closed。
 * 点踩候选的 turnId 是 assistant message.id，匹配不上时按 created_at 时间锚
 * （resolveFeedbackTurn：startTime 不晚于点踩时刻的最后一轮），不许把 message.id 当轮 id。
 */
function resolveTriggerOwner(
  turns: HarvestReplayTurns,
  candidate: PostLaunchReflowCandidate,
  turnRows: readonly HarvestTurnRow[],
): { owner: HarvestTurnRow; index: number } {
  const byId = new Map(turnRows.map((row) => [row.id, row]));
  const trueRow = candidate.turnId ? byId.get(candidate.turnId) : undefined;
  if (trueRow) {
    const owner = ownerRowOf(trueRow, byId);
    const index = replayIndexOfRow(turns, owner);
    if (index < 0) throw new Error(REFLOW_TURN_MISMATCH_MESSAGE);
    return { owner, index };
  }
  if (!candidate.sources.includes('feedback')) throw new Error(REFLOW_TURN_MISMATCH_MESSAGE);
  const anchor = candidate.occurredAt ?? candidate.feedbackAt;
  if (anchor == null) throw new Error(REFLOW_TURN_MISMATCH_MESSAGE);
  const anchored = resolveFeedbackTurn(turns, anchor);
  if (!anchored) throw new Error(REFLOW_TURN_MISMATCH_MESSAGE);
  const anchoredRow = turnRows.find((row) => (
    row.turn_number === anchored.turnNumber && row.start_time === anchored.startTime
  ));
  const owner = anchoredRow
    ? ownerRowOf(anchoredRow, byId)
    : {
      id: anchored.parentTurnId ?? '',
      turn_number: anchored.turnNumber,
      start_time: anchored.startTime,
      turn_type: anchored.turnType === 'iteration' ? 'iteration' : 'user',
      parent_turn_id: anchored.parentTurnId ?? null,
    };
  const index = replayIndexOfRow(turns, owner);
  if (index < 0) throw new Error(REFLOW_TURN_MISMATCH_MESSAGE);
  return { owner, index };
}

/** 父轮及其全部 iteration 子轮的回放下标闭区间，与 collectScorableTurns 同一归属。 */
function ownedReplayRange(
  turns: HarvestReplayTurns,
  owner: HarvestTurnRow,
  turnRows: readonly HarvestTurnRow[],
  ownerIndex: number,
): { start: number; end: number } {
  const byKey = new Map(turnRows.map((row) => [`${row.turn_number}:${row.start_time}`, row]));
  let firstOwned = ownerIndex;
  let lastOwned = ownerIndex;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turnBelongsToOwner(turn, owner, byKey.get(`${turn.turnNumber}:${turn.startTime}`))) continue;
    firstOwned = Math.min(firstOwned, index);
    lastOwned = Math.max(lastOwned, index);
  }
  let userIndex = -1;
  for (let cursor = ownerIndex; cursor >= 0; cursor -= 1) {
    if (turnHasUserPrompt(turns[cursor])) {
      userIndex = cursor;
      break;
    }
  }
  return {
    start: Math.min(userIndex >= 0 ? userIndex : ownerIndex, firstOwned),
    end: lastOwned,
  };
}

function listHarvestTurnRows(db: BetterSqlite3.Database, sessionId: string): HarvestTurnRow[] {
  const rows = db.prepare(`
    SELECT id, turn_number, start_time, turn_type, parent_turn_id
    FROM telemetry_turns WHERE session_id = ?
  `).all(sessionId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    turn_number: Number(row.turn_number),
    start_time: Number(row.start_time),
    turn_type: typeof row.turn_type === 'string' && row.turn_type ? row.turn_type : 'user',
    parent_turn_id: row.parent_turn_id == null || row.parent_turn_id === '' ? null : String(row.parent_turn_id),
  }));
}

/**
 * 按保存时的同意档裁剪回放。full_session 不裁；turn_excerpt（及更低档）只留触发
 * 父轮 + 它的全部 iteration 子轮（及往前最近一条带用户原话的轮），不得带上别的用户轮。
 * 评分/信号候选 turnId 对不上 telemetry_turns↔回放映射时 fail-closed；
 * 点踩候选走 created_at 时间锚，禁止把 message.id 当轮 id。
 */
export function scopeReplayToCandidate(
  replay: StructuredReplay,
  candidates: readonly PostLaunchReflowCandidate[],
  consentScope: PostLaunchConsentScope,
  turnRows: readonly HarvestTurnRow[] = [],
): StructuredReplay {
  if (consentScope === 'full_session') return replay;
  const match = candidates.find((candidate) => candidate.sessionId === replay.sessionId);
  if (!match) throw new Error(REFLOW_TURN_MISMATCH_MESSAGE);
  const turns = replay.turns ?? [];
  const { owner, index } = resolveTriggerOwner(turns, match, turnRows);
  const { start, end } = ownedReplayRange(turns, owner, turnRows, index);
  return { ...replay, turns: turns.slice(start, end + 1) };
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
  consentScope: PostLaunchConsentScope,
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
      consentScope,
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
      const turnRows = postLaunchReflow && db ? listHarvestTurnRows(db, sessionId) : [];
      const scopedReplay = postLaunchReflow
        ? scopeReplayToCandidate(replay, sessionCandidates, consentScope, turnRows)
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
        seed = applyPostLaunchReflowProvenance(seed, sessionCandidates, consentScope);
      }
      seeds.push(seed);
    } catch (error) {
      failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { seeds, failed };
}
