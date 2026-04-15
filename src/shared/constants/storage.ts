/** 内存/向量配置 */
export const MEMORY = {
  /** 默认相似度阈值 */
  SIMILARITY_THRESHOLD: 0.7,
  /** 最大返回结果数 */
  MAX_RESULTS: 10,
  /** 嵌入维度 */
  EMBEDDING_DIMENSION: 1536,
  /** 索引刷新间隔 (ms) */
  INDEX_REFRESH_INTERVAL: 300000,
  /** Entity relation time decay half-life in days */
  RELATION_DECAY_DAYS: 30,
  /** Minimum confidence after decay to keep a relation */
  RELATION_MIN_CONFIDENCE: 0.1,
  /** Minimum confidence for context builder relation queries */
  RELATION_CONTEXT_MIN_CONFIDENCE: 0.2,
  /** Embedding cache TTL in ms (10 min) */
  EMBEDDING_CACHE_TTL: 10 * 60 * 1000,
  /** Deduplication Jaccard similarity threshold */
  DEDUP_SIMILARITY_THRESHOLD: 0.85,
  /** Memory record time decay half-life in days (longer than relations, memories are more durable) */
  RECORD_DECAY_DAYS: 90,
  /** Minimum memory confidence after decay */
  RECORD_MIN_CONFIDENCE: 0.1,
  /** Episodic FTS 索引的保留天数（超过此天数的消息触发 prune 可被清理） */
  EPISODIC_INDEX_RETENTION_DAYS: 90,
  /** EpisodicRecall 工具默认返回条数 */
  EPISODIC_RECALL_DEFAULT_LIMIT: 5,
  /** EpisodicRecall 工具最大返回条数 */
  EPISODIC_RECALL_MAX_LIMIT: 10,
  /** EpisodicRecall 单条消息片段最大字符数 */
  EPISODIC_SNIPPET_MAX_CHARS: 300,
} as const;

/** 向量存储配置 */
export const VECTOR_STORE = {
  /** 最大文档数 */
  MAX_DOCUMENTS: 10000,
  /** 默认 TopK */
  DEFAULT_TOP_K: 10,
  /** 默认相似度阈值 */
  DEFAULT_THRESHOLD: 0.7,
  /** 分块大小 */
  CHUNK_SIZE: 1000,
  /** 分块重叠 */
  CHUNK_OVERLAP: 100,
} as const;

/** Embedding 服务配置 */
export const EMBEDDING = {
  /** 最大缓存大小 */
  MAX_CACHE_SIZE: 10000,
  /** 批量处理大小 */
  BATCH_SIZE: 100,
} as const;

/** 历史记录配置 */
export const HISTORY = {
  /** 使用记录最大条数 */
  MAX_USAGE_HISTORY: 1000,
  /** Token 记录最大条数 */
  MAX_TOKEN_HISTORY: 1000,
} as const;

/** 协调器 checkpoint 持久化 */
export const COORDINATION_CHECKPOINTS = {
  /** AutoAgentCoordinator checkpoint 目录名（相对 getUserConfigDir()） */
  AUTO_DIR: 'coordination-checkpoints',
  /** ParallelAgentCoordinator checkpoint 目录名（相对 getUserConfigDir()） */
  PARALLEL_DIR: 'parallel-coordination-checkpoints',
  /** 当前快照 schema 版本，读入时用于向前兼容判断 */
  SCHEMA_VERSION: 1,
} as const;

/** Swarm Trace 持久化（ADR-010 #5） */
export const SWARM_TRACE = {
  /** 单次 list 默认返回 run 数量上限 */
  DEFAULT_LIST_LIMIT: 50,
  /** list 接口允许的最大 run 数量 */
  MAX_LIST_LIMIT: 200,
  /** 单个 run 最多保留的 timeline 事件数（避免极端长 run 撑爆表） */
  MAX_EVENTS_PER_RUN: 2000,
  /** 单条事件 payload_json 序列化后的字节上限（超过则截断） */
  MAX_EVENT_PAYLOAD_BYTES: 8 * 1024,
} as const;

/** 资源管理常量 */
export const RESOURCE_MANAGEMENT = {
  /** 磁盘空间警告阈值（1GB） */
  DISK_WARNING_BYTES: 1024 * 1024 * 1024,
  /** 磁盘空间临界阈值（100MB） */
  DISK_CRITICAL_BYTES: 100 * 1024 * 1024,
  /** 日志文件最大大小（10MB） */
  LOG_MAX_FILE_SIZE: 10 * 1024 * 1024,
  /** 日志文件最大数量 */
  LOG_MAX_FILES: 10,
  /** 优雅关闭超时（5秒） */
  GRACEFUL_SHUTDOWN_TIMEOUT: 5_000,
} as const;
