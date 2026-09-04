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
} from '@shared/contract/evaluation';
import { HARVEST_LOCKED_FIELDS } from '@shared/contract/evaluation';
import { deriveHarvestSeed } from './harvestCandidates';
import { queryNegativeFeedback } from './trajectoryToCase';

/** 一次最多收多少场：模态本来就是人手选的量级，超出直接拒，不做分页。 */
const HARVEST_MAX_SESSIONS = 20;
/** 单场会话读多少条点踩：反向候选只需要少量锚点。 */
const NEGATIVE_FEEDBACK_LIMIT = 10;

function harvestBatchTag(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `harvest-${month}${day}`;
}

function normalizeRequest(payload: HarvestPreviewRequest): { sessionIds: string[]; fields: HarvestFieldKey[] } {
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
  return { sessionIds, fields };
}

export async function buildHarvestPreview(payload: HarvestPreviewRequest): Promise<HarvestPreviewResult> {
  const { sessionIds, fields } = normalizeRequest(payload);
  const [{ extractStructuredReplay }, { getDatabase }] = await Promise.all([
    import('@host/telemetry/replay/replayService'),
    import('@host/services/core/databaseService'),
  ]);
  const database = getDatabase();
  const batchTag = harvestBatchTag();
  const seeds: HarvestDraftSeed[] = [];
  const failed: HarvestPreviewResult['failed'] = [];

  for (const sessionId of sessionIds) {
    try {
      const replay = await extractStructuredReplay(sessionId);
      if (!replay) throw new Error('这场会话没有可回放的记录');
      const session = database.getSession(sessionId);
      const db = database.getDb();
      const seed = deriveHarvestSeed({
        replay,
        sessionTitle: session?.title?.trim() || sessionId,
        workingDirectory: session?.workingDirectory ?? '',
        fields,
        batchTag,
        negativeFeedbackAt: db
          ? queryNegativeFeedback(db, { limit: NEGATIVE_FEEDBACK_LIMIT, sessionId }).map((row) => row.createdAt)
          : [],
      });
      if (!seed.prompt) throw new Error('这场会话没有可用的用户原话');
      seeds.push(seed);
    } catch (error) {
      failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { seeds, failed };
}
