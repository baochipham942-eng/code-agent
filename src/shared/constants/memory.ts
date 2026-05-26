// ============================================================================
// Light Memory 常量 — File-as-Memory 架构（session 判断 + consolidation 闭环）
// 禁止在 lightMemory/cron 业务代码里散布这些字面量，统一从这里引用。
// ============================================================================

/** Light Memory 通用预算 */
export const LIGHT_MEMORY = {
  /**
   * INDEX.md 行预算。超过则：① indexLoader 加载时截断兜底；② consolidation 触发压缩。
   * （原先散落在 indexLoader.ts 的 200 字面量收口到此处）
   */
  INDEX_MAX_LINES: 200,
} as const;

/** session 收尾 LLM 判断（runFinalizer → conversationJudge） */
export const SESSION_JUDGE = {
  /** quick model max_tokens：只需返回一小段 JSON 判断，给足余量即可 */
  MAX_TOKENS: 256,
  /** quick model 调用超时（ms）。收尾异步执行，不阻塞会话，给比 intent 分类宽松的窗口 */
  TIMEOUT_MS: 8000,
  /** 参与判断的最近用户轮数（多轮会话取最近 N 轮即可锁定当前主题） */
  RECENT_USER_TURNS: 8,
} as const;

/** 记忆 consolidation（cron 周期任务 → consolidation 模块） */
export const MEMORY_CONSOLIDATION = {
  /** 调度 cron 表达式（6 字段，croner）：默认每周一 04:00 本地时间 */
  CRON_EXPRESSION: '0 0 4 * * 1',
  /**
   * 内置 consolidation job 是否 dry-run。
   * 首版 = true（只输出计划/diff、不落盘），dry-run 验证信息无损后再改 false 开真写。
   */
  DRY_RUN_DEFAULT: true,
  /** 触发 consolidation 的 memory 文件数阈值（低于此且 INDEX 未超预算则跳过，不烧 token） */
  FILE_COUNT_THRESHOLD: 40,
  /** LLM 压缩调用 max_tokens（要容纳合并后的多份文件正文） */
  MAX_TOKENS: 4096,
  /** LLM 压缩调用超时（ms） */
  TIMEOUT_MS: 60000,
  /** 单次最多投喂给 LLM 的文件正文字符数（防止超长 prompt 爆预算） */
  MAX_INPUT_CHARS: 24000,
  /** 内置 job 识别标签（启动时按此 tag 查重，避免重复注册） */
  JOB_TAG: 'light-memory-consolidation',
} as const;
