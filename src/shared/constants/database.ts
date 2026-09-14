/**
 * SQLite / FTS 自愈与降级常量。
 * 对齐 TELEMETRY_RETENTION 的分组写法：阈值与稳定 code 只在这里出现。
 */
export const SQLITE_FTS = {
  /** addMessage 在 FTS 自愈后再试的次数（不含第一次） */
  WRITE_RETRY_LIMIT: 1,
  /**
   * PersistenceHealth.reason 稳定 code：FTS 已禁用，搜索走 LIKE。
   * host 只报这个 code，文案由 renderer i18n 翻译。
   */
  DISABLED_REASON: 'FTS_DISABLED',
  /**
   * PersistenceHealth.reason 稳定 code：FTS 已空表重建但回填未完成/失败，
   * 搜索走 LIKE 且历史索引不完整；backfill 成功后降级态消除。
   */
  EMPTY_RECREATED_REASON: 'FTS_EMPTY_RECREATED',
  /** 启动 / 运行时探针用的 MATCH 短语（trigram ≥3，故意不命中真实内容） */
  HEALTH_PROBE_MATCH: '"___fts_health_probe___"',
} as const;
