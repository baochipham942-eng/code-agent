// ============================================================================
// Trajectory → Case 回流桥（批 1 · B1）
// ----------------------------------------------------------------------------
// 把线上真实坏信号（点踩 / risk 回合 / failure journal 模式）抽成回归用例
// YAML 草稿。草稿只带 prompt 与溯源信息，expect 留空——断言必须人工补
// （自动生成断言违反 manual_review 纪律），未补断言前天然落 self_check 弱证据桶。
// ============================================================================

import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import path from 'path';
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
  /** 幂等判别符：feedback 行 id / message id / journal key 短哈希（非位置序号） */
  discriminator: string;
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

/**
 * 从 telemetry_turns 取用户原话（web 会话的 user 输入不落 messages 表，
 * 只在 telemetry_turns.user_prompt——dogfood 实测踩到）。三级：
 * turnId 精确且非空 → 锚点时间之前最近非空 → 会话最后一条非空；都无 → null。
 */
export function resolveTurnPrompt(
  db: SQLiteDatabase,
  sessionId: string,
  anchor: { turnId: string | null; anchorTimestamp: number | null },
): string | null {
  if (anchor.turnId) {
    const exact = db
      .prepare(`SELECT user_prompt FROM telemetry_turns WHERE id = ? AND session_id = ?`)
      .get(anchor.turnId, sessionId) as { user_prompt?: string | null } | undefined;
    if (exact?.user_prompt?.trim()) return exact.user_prompt;
  }
  const rows = db
    .prepare(
      `SELECT user_prompt, start_time FROM telemetry_turns
       WHERE session_id = ? AND user_prompt IS NOT NULL AND trim(user_prompt) != ''
       ORDER BY start_time DESC`,
    )
    .all(sessionId) as Array<{ user_prompt: string; start_time: number }>;
  if (rows.length === 0) return null;
  if (anchor.anchorTimestamp !== null) {
    // 锚点早于全部 turns → null 让调用方走 messages 回溯；
    // 回落"会话最新 prompt"会拿到晚于反馈的原话（Gemini 审计 R1 HIGH）。
    const before = rows.find((r) => r.start_time <= anchor.anchorTimestamp!);
    return before ? before.user_prompt : null;
  }
  return rows[0].user_prompt;
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
export function journalPatternToDraftSeed(pattern: FailurePattern): Omit<DraftSeed, 'id' | 'source' | 'discriminator'> {
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

/**
 * 幂等文件名：同 source+session+稳定判别符 → 同名。
 * 判别符必须来自信号本体（feedback 行 id / message id / journal key），
 * 不能用列表位置序号——新信号到来会让序号漂移，旧文件被误判存在、
 * 新信号被跳过（自查抓到的缺陷）。所有片段清洗防路径穿越。
 */
export function draftFileName(source: DraftSource, sessionId: string, discriminator: string | number): string {
  const clean = (v: string) => v.replace(/[^a-zA-Z0-9_-]+/g, '-');
  // 清洗把特殊字符折叠成 '-'，纯拼接会产生歧义碰撞（s1-a + 1 == s1 + a-1，
  // Gemini 审计 R1 MED）——追加原始三元组的短哈希做唯一性兜底。
  const uniq = createHash('sha1')
    .update(`${source}|${sessionId}|${String(discriminator)}`)
    .digest('hex')
    .slice(0, 6);
  return `draft-${source}-${clean(sessionId)}-${clean(String(discriminator))}-${uniq}.yaml`;
}

export interface WriteDraftsResult {
  written: string[];
  existed: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * 批量写草稿：已存在跳过（幂等，防覆盖人工编辑）；单文件写失败只记入
 * failed 不炸整批（Gemini 审计 R1 HIGH——此前 writeFile 异常会丢掉剩余种子）。
 */
export async function writeDraftFiles(seeds: DraftSeed[], outDir: string): Promise<WriteDraftsResult> {
  await fsp.mkdir(outDir, { recursive: true });
  const result: WriteDraftsResult = { written: [], existed: [], failed: [] };
  for (const seed of seeds) {
    const fileName = draftFileName(seed.source, seed.sourceSessionId, seed.discriminator);
    const filePath = path.join(outDir, fileName);
    try {
      await fsp.access(filePath);
      result.existed.push(fileName);
      continue;
    } catch {
      // 不存在（或不可读——写失败会在下面如实上报）→ 尝试写入
    }
    try {
      const alignedSeed = { ...seed, id: fileName.replace(/\.yaml$/, '') };
      await fsp.writeFile(filePath, buildDraftYaml(alignedSeed), 'utf-8');
      result.written.push(fileName);
    } catch (error) {
      result.failed.push({ file: fileName, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
