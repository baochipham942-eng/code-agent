// ============================================================================
// Trajectory → Case 回流桥（批 1 · B1）
// ----------------------------------------------------------------------------
// 把线上真实坏信号（点踩 / risk 回合 / failure journal 模式）抽成回归用例
// YAML 草稿。草稿只带 prompt 与溯源信息，expect 留空——断言必须人工补
// （自动生成断言违反 manual_review 纪律），未补断言前天然落 self_check 弱证据桶。
// ============================================================================

import { dump as dumpYaml } from 'js-yaml';
import type { Database as SQLiteDatabase } from 'better-sqlite3';
import type { Message } from '../../shared/contract';
import type { FailurePattern } from '../lightMemory/failureJournal';

export type DraftSource = 'feedback' | 'quality' | 'journal';

export interface NegativeFeedbackRow {
  id: string;
  sessionId: string;
  turnId: string | null;
  messageId: string | null;
  comment: string | null;
  createdAt: number;
}

export interface DraftSeed {
  id: string;
  source: DraftSource;
  prompt: string;
  sourceSessionId: string;
  note?: string;
}

/** 只读查询点踩反馈（rating=-1），时间倒序。 */
export function queryNegativeFeedback(
  db: SQLiteDatabase,
  options: { limit: number },
): NegativeFeedbackRow[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, turn_id, message_id, comment, created_at
       FROM telemetry_feedback
       WHERE rating = -1
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(options.limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    sessionId: String(row.session_id),
    turnId: (row.turn_id as string | null) ?? null,
    messageId: (row.message_id as string | null) ?? null,
    comment: (row.comment as string | null) ?? null,
    createdAt: Number(row.created_at),
  }));
}

/**
 * 从会话消息里回溯反馈对应的用户原话（两级 fallback）：
 * 1. feedback.messageId/turnId 命中某条消息 → 取该消息之前最近的 user 原话
 *    （真实聊天反馈把 assistant message.id 同时写进 turnId/messageId，
 *    与 telemetry turn 的 currentTurnId 不是一套 id，不能只按 turn 精确找）。
 * 2. 都没命中 → 回退取会话最后一条 user 原话。
 */
export function resolveFeedbackPrompt(
  messages: Message[],
  feedback: { messageId: string | null; turnId: string | null },
): string | null {
  const ordered = [...messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const anchorIndex = ordered.findIndex(
    (m) => m.id === feedback.messageId || (feedback.turnId !== null && m.id === feedback.turnId),
  );

  const searchFrom = anchorIndex >= 0 ? anchorIndex : ordered.length - 1;
  for (let i = searchFrom; i >= 0; i--) {
    const m = ordered[i];
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return m.content;
    }
  }
  return null;
}

/** 取 turnQuality 总评 grade === 'risk' 的 assistant 消息（回流入口 2）。 */
export function selectRiskTurnMessages(messages: Message[]): Message[] {
  return messages.filter(
    (m) => m.role === 'assistant' && m.metadata?.turnQuality?.score?.grade === 'risk',
  );
}

/**
 * failure journal 模式 → 草稿种子（回流入口 3）。
 * journal 只有跨会话沉淀的模式（无单次用户原话），prompt 用模式描述占位，
 * 人工 review 时应替换为能复现该失败的真实任务描述。
 */
export function journalPatternToDraftSeed(pattern: FailurePattern): Omit<DraftSeed, 'id' | 'source'> {
  const sessionId = pattern.sessions[pattern.sessions.length - 1] ?? 'unknown-session';
  return {
    prompt: `【journal 模式占位，review 时替换为可复现任务】${pattern.pattern}`,
    sourceSessionId: sessionId,
    note: `failure journal：${pattern.toolName}（${pattern.errorCategory}）累计 ${pattern.count} 次；样本：${pattern.sampleError}`,
  };
}

const CHECKLIST_HEADER = `# ============================================================================
# 回归用例草稿（trajectory:to-case 生成）——review 前不进正式套件
# ----------------------------------------------------------------------------
# 断言硬化 checklist（人工完成后把文件移出 drafts/ 并改 reviewStatus）：
#   [ ] 1. 打开 sourceSessionId 对应会话 Replay，确认失败现象与期望行为
#   [ ] 2. 补 deterministic 断言（expect.files_exist / expect.output_contains /
#          expectations 断言家族），否则该用例永远是 self_check 弱证据
#   [ ] 3. journal 类草稿：把占位 prompt 替换为能复现该失败的真实任务描述
#   [ ] 4. 补 type/tags/timeout（默认 type: task 仅为占位）
#   [ ] 5. reviewStatus: pending → reviewed，移入正式目录
# ============================================================================
`;

/** 生成单用例草稿 YAML（含 checklist 注释头，js-yaml 可安全解析）。 */
export function buildDraftYaml(seed: DraftSeed): string {
  const body = dumpYaml(
    {
      name: `draft-${seed.source}-${seed.sourceSessionId}`,
      description: `回流草稿（${seed.source}）${seed.note ? `：${seed.note}` : ''}`,
      cases: [
        {
          id: seed.id,
          type: 'task',
          description: seed.note ?? `回流草稿（${seed.source}）`,
          prompt: seed.prompt,
          sourceSessionId: seed.sourceSessionId,
          reviewStatus: 'pending',
          expect: {},
        },
      ],
    },
    { lineWidth: 120, noRefs: true },
  );
  return `${CHECKLIST_HEADER}${body}`;
}

/** 幂等文件名：同 source+session+序号 → 同名（重复跑不重复堆文件）。 */
export function draftFileName(source: DraftSource, sessionId: string, index: number): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `draft-${source}-${safeSession}-${index}.yaml`;
}
