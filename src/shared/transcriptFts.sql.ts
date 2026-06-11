// ============================================================================
// Transcript FTS5 — 会话转录按 kind 分解的全文索引（roadmap 2.1）
// ============================================================================
// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license) — history/fts 设计
// （kind 分解 user_text/assistant_text/reasoning/tool_input/tool_output），
// 实现按 Neo 的 messages 单表 + triggers 同步模式重写。
//
// 设计要点：
// - 与 session_messages_fts（episodic recall，仅 content）并存：本表覆盖
//   tool_calls / tool_results / thinking 的逐 kind 索引，服务 History 工具与
//   后续 dream/distill 的"轨迹库为权威来源"。
// - 同步走 triggers：messages 的所有写路径（Electron repo / CLI db / sync）
//   都被捕获，应用层无感知。
// - JSON 分解在 SQL 内做（json_each + json_extract），malformed JSON 用
//   json_valid 守卫降级为 '[]'，绝不让 trigger 失败拖垮宿主 INSERT。
// - body 一律 substr 截断到 TRANSCRIPT_FTS_BODY_CAP：tool 输出可能很大且
//   每次 tool_call_end 会整条重建索引，trigram 全量索引大输出是 O(n²) 浪费。
// - 本模块同时被 Electron schema、CLI database 和单测导入——单一事实来源。
// ============================================================================

/** 单条 FTS body 的字符上限（substr 截断，保头部） */
export const TRANSCRIPT_FTS_BODY_CAP = 8192;

export const TRANSCRIPT_KINDS = [
  'user_text',
  'assistant_text',
  'reasoning',
  'tool_input',
  'tool_output',
] as const;

export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number];

// ----------------------------------------------------------------------------
// SQL fragments
// ----------------------------------------------------------------------------

/** 排除 meta 消息 + 循环内部消息（与 session_messages_fts 的过滤规则一致） */
function baseFilter(ref: string): string {
  return (
    `COALESCE(${ref}.is_meta, 0) = 0` +
    ` AND COALESCE(${ref}.content, '') NOT LIKE '%【循环模式 · 第%轮】%'` +
    ` AND COALESCE(${ref}.content, '') NOT LIKE '%[[LOOP_WAIT]]%'`
  );
}

/** malformed / NULL JSON 降级为空数组，防止 json_each 抛错中断宿主语句 */
function safeJsonArray(expr: string): string {
  return `CASE WHEN json_valid(${expr}) THEN ${expr} ELSE '[]' END`;
}

const INSERT_COLUMNS =
  'INSERT INTO transcript_fts (message_id, session_id, kind, tool_name, body, timestamp)';

/**
 * 生成 5 类 kind 的 INSERT…SELECT 语句。
 *
 * @param ref          行引用：trigger 场景传 'new'，backfill 场景传表别名
 * @param fromMessages backfill 场景为 true，语句会扫 `FROM messages <ref>`；
 *                     trigger 场景为 false，直接引用 new.* 行
 */
function buildInsertSelects(ref: string, fromMessages: boolean): string[] {
  const cap = TRANSCRIPT_FTS_BODY_CAP;
  const base = baseFilter(ref);
  // trigger 场景文本类语句没有 FROM；json 类语句 FROM json_each(...)。
  // backfill 场景所有语句都先 FROM messages <ref>。
  const msgFrom = fromMessages ? `FROM messages ${ref}` : '';
  const msgFromJoin = (extra: string) =>
    fromMessages ? `FROM messages ${ref}, ${extra}` : `FROM ${extra}`;
  const toolCallsJson = safeJsonArray(`${ref}.tool_calls`);
  const toolResultsJson = safeJsonArray(`${ref}.tool_results`);

  const userAssistantText = `
    ${INSERT_COLUMNS}
    SELECT ${ref}.id, ${ref}.session_id,
           CASE ${ref}.role WHEN 'user' THEN 'user_text' ELSE 'assistant_text' END,
           NULL,
           substr(${ref}.content, 1, ${cap}),
           ${ref}.timestamp
    ${msgFrom}
    WHERE ${base}
      AND ${ref}.role IN ('user', 'assistant')
      AND COALESCE(${ref}.content, '') <> ''`;

  const reasoning = `
    ${INSERT_COLUMNS}
    SELECT ${ref}.id, ${ref}.session_id, 'reasoning', NULL,
           substr(${ref}.thinking, 1, ${cap}),
           ${ref}.timestamp
    ${msgFrom}
    WHERE ${base}
      AND COALESCE(${ref}.thinking, '') <> ''`;

  const toolInput = `
    ${INSERT_COLUMNS}
    SELECT ${ref}.id, ${ref}.session_id, 'tool_input',
           COALESCE(json_extract(tc.value, '$.name'), ''),
           substr(
             COALESCE(json_extract(tc.value, '$.name'), '') || ' '
               || COALESCE(json_extract(tc.value, '$.arguments'), '{}'),
             1, ${cap}),
           ${ref}.timestamp
    ${msgFromJoin(`json_each(${toolCallsJson}) AS tc`)}
    WHERE ${base}`;

  // tool 结果的主路径：result 内嵌在 tool_calls[*].result（tool_call_end 回填）
  const toolOutputInline = `
    ${INSERT_COLUMNS}
    SELECT ${ref}.id, ${ref}.session_id, 'tool_output',
           COALESCE(json_extract(tc.value, '$.name'), ''),
           substr(
             COALESCE(json_extract(tc.value, '$.name'), '') || ' '
               || COALESCE(json_extract(tc.value, '$.result.output'), '')
               || CASE WHEN COALESCE(json_extract(tc.value, '$.result.error'), '') <> ''
                       THEN ' ERROR: ' || json_extract(tc.value, '$.result.error')
                       ELSE '' END,
             1, ${cap}),
           ${ref}.timestamp
    ${msgFromJoin(`json_each(${toolCallsJson}) AS tc`)}
    WHERE ${base}
      AND json_extract(tc.value, '$.result') IS NOT NULL
      AND (COALESCE(json_extract(tc.value, '$.result.output'), '') <> ''
           OR COALESCE(json_extract(tc.value, '$.result.error'), '') <> '')`;

  // 兼容路径：tool_results 独立列（CLI / 旧数据）。tool_name 反查 tool_calls；
  // 已有内嵌 result 的条目去重跳过，避免双写。
  const toolOutputColumn = `
    ${INSERT_COLUMNS}
    SELECT ${ref}.id, ${ref}.session_id, 'tool_output',
           COALESCE((SELECT json_extract(tc.value, '$.name')
                     FROM json_each(${toolCallsJson}) AS tc
                     WHERE json_extract(tc.value, '$.id') = json_extract(tr.value, '$.toolCallId')
                     LIMIT 1), ''),
           substr(
             COALESCE(json_extract(tr.value, '$.output'), '')
               || CASE WHEN COALESCE(json_extract(tr.value, '$.error'), '') <> ''
                       THEN ' ERROR: ' || json_extract(tr.value, '$.error')
                       ELSE '' END,
             1, ${cap}),
           ${ref}.timestamp
    ${msgFromJoin(`json_each(${toolResultsJson}) AS tr`)}
    WHERE ${base}
      AND (COALESCE(json_extract(tr.value, '$.output'), '') <> ''
           OR COALESCE(json_extract(tr.value, '$.error'), '') <> '')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(${toolCallsJson}) AS tc2
        WHERE json_extract(tc2.value, '$.id') = json_extract(tr.value, '$.toolCallId')
          AND json_extract(tc2.value, '$.result') IS NOT NULL
      )`;

  return [userAssistantText, reasoning, toolInput, toolOutputInline, toolOutputColumn];
}

// ----------------------------------------------------------------------------
// Public DDL
// ----------------------------------------------------------------------------

export const TRANSCRIPT_FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
    message_id UNINDEXED,
    session_id UNINDEXED,
    kind UNINDEXED,
    tool_name UNINDEXED,
    body,
    timestamp UNINDEXED,
    tokenize = 'trigram'
  )
`;

/** snippet() 用的 body 列下标（0-based，对应上面建表列序） */
export const TRANSCRIPT_FTS_BODY_COLUMN_INDEX = 4;

/** backfill 用的 INSERT…SELECT 语句组（扫全量 messages 表） */
export const TRANSCRIPT_FTS_BACKFILL_STATEMENTS: readonly string[] = buildInsertSelects('m', true);

/**
 * 应用 transcript_fts 表 + 同步 triggers。幂等；insert/update trigger 走
 * drop + recreate，已有库升级时能拿到最新的分解规则。
 */
export function applyTranscriptFtsSchema(db: { exec(sql: string): unknown }): void {
  db.exec(TRANSCRIPT_FTS_TABLE_SQL);

  const inserts = buildInsertSelects('new', false)
    .map((stmt) => `${stmt};`)
    .join('\n');

  db.exec(`
    DROP TRIGGER IF EXISTS transcript_ai_fts;
    DROP TRIGGER IF EXISTS transcript_au_fts;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS transcript_ai_fts AFTER INSERT ON messages BEGIN
      ${inserts}
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS transcript_ad_fts AFTER DELETE ON messages BEGIN
      DELETE FROM transcript_fts WHERE message_id = old.id;
    END
  `);

  // visibility 变化不触发重建：rewound 过滤在查询期 join messages 完成
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS transcript_au_fts
    AFTER UPDATE OF content, thinking, tool_calls, tool_results, is_meta ON messages BEGIN
      DELETE FROM transcript_fts WHERE message_id = old.id;
      ${inserts}
    END
  `);
}
