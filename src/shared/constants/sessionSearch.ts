/**
 * 会话搜索（UI 跨会话搜索）相关阈值。
 * 背景：UI 搜索主路径走已有的 SQLite FTS（trigram，覆盖全库）；
 * 短查询 / caseSensitive / DB 未就绪时回落内存 LRU 搜索（原行为）。
 */
export const SESSION_SEARCH = {
  /** trigram FTS 的最小查询长度；低于此长度召回恒为空，回落内存搜索 */
  FTS_MIN_QUERY_LENGTH: 3,
  /** UI 搜索从 FTS 取回的候选行数上限（取回后按现有 relevance 规则在内存重排） */
  FTS_CANDIDATE_LIMIT: 500,
  /** searchSessionMessagesFts 的默认 limit 硬上限（agent 记忆侧语义，保持原值） */
  FTS_QUERY_LIMIT_CAP: 50,
  /** 搜索回填缓存 / 轮次推断时每会话加载的消息窗口（原 CROSS_SESSION_SEARCH_MESSAGE_LIMIT） */
  HYDRATE_MESSAGE_LIMIT: 500,
};
