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

/**
 * 主库完整性探针 / 备份轮转。
 * Tier 1 必须便宜（LIMIT 1），禁止把 PRAGMA integrity_check / quick_check 塞进 init 同步路径。
 */
export const SQLITE_INTEGRITY = {
  /** Tier 2 PRAGMA quick_check 节流间隔（毫秒） */
  QUICK_CHECK_MIN_INTERVAL_MS: 24 * 60 * 60 * 1000,
  /** 子进程 quick_check 等待排他锁 */
  QUICK_CHECK_BUSY_TIMEOUT_MS: 30 * 1000,
  /** 1.6GB 全扫估秒级到十几秒，留足余量后强杀 */
  QUICK_CHECK_TIMEOUT_MS: 10 * 60 * 1000,
  /** 备份节流：每日一次 */
  BACKUP_MIN_INTERVAL_MS: 24 * 60 * 60 * 1000,
  /** 轮转份数：code-agent.db.backup-1 / backup-2 */
  BACKUP_KEEP: 2,
  /** 备份所需空闲磁盘 = 库体积 × 该倍数（一份完整副本 + 余量） */
  BACKUP_FREE_SPACE_FACTOR: 2.5,
  /** Tier 1 探针预算（毫秒）；好库启动回归口径是基线 +200ms */
  TIER1_PROBE_BUDGET_MS: 200,
  /** 无可用备份时 PersistenceHealth.reason 稳定 code；host 不加裸中文 */
  CORRUPT_NO_BACKUP: 'DB_CORRUPT_NO_BACKUP',
  /** 备份还在但复制/打开恢复副本失败（如磁盘满）；不可重试，严禁空路径建空库顶替 */
  RESTORE_FAILED: 'DB_RESTORE_FAILED',
  /** 升级恢复 preflight：有备份但磁盘余量不足；不隔离可读库，可重试（空间够了下次启动自动恢复） */
  RESTORE_LOW_DISK: 'DB_RESTORE_LOW_DISK',
  /** 已从备份恢复；reason 形如 DB_RECOVERED_FROM_BACKUP:<ISO> */
  RECOVERED_FROM_BACKUP: 'DB_RECOVERED_FROM_BACKUP',
  /** Tier 2 quick_check 失败 */
  QUICK_CHECK_FAILED: 'DB_QUICK_CHECK_FAILED',
  /** 局部表损坏（未隔离） */
  LOCAL_CORRUPT: 'DB_LOCAL_CORRUPT',
  MARKER_INTEGRITY: '.last-integrity-check',
  MARKER_INTEGRITY_FAILED: '.integrity-failed',
  MARKER_BACKUP: '.last-db-backup',
  /** 隔离后无备份：禁止在空路径上 new Database() 造出空库 */
  MARKER_UNRECOVERABLE: '.db-unrecoverable',
} as const;
