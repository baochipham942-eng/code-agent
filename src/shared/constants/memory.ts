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
  /** dump 时每个文件正文至少保留的字符数（保证小文件也完整可见，便于查重） */
  MIN_FILE_BODY_CHARS: 200,
  /** 内置 job 识别标签（启动时按此 tag 查重，避免重复注册） */
  JOB_TAG: 'light-memory-consolidation',
} as const;

/** 持久化角色资产（roles/<name>/ 三层记忆 + 履历 + 写回，docs/designs/persistent-role-assets.md） */
export const ROLE_ASSETS = {
  /** 角色资产根目录名（相对 getUserConfigDir()）：~/.code-agent/roles/ */
  ROLES_DIR: 'roles',
  /** 项目记忆根目录名（相对 getUserConfigDir()）：~/.code-agent/projects/（P0-2 项目空间落地前的过渡 key） */
  PROJECTS_DIR: 'projects',
  /** 角色/项目记忆正文子目录名 */
  MEMORIES_SUBDIR: 'memories',
  /** 记忆索引文件名（注入用，格式与全局 Light Memory INDEX.md 一致） */
  INDEX_FILENAME: 'MEMORY.md',
  /** 工作履历文件名（产物清单，设计 §4.3） */
  HISTORY_FILENAME: 'history.md',
  /** 项目目录元数据文件名（记录原始 workspace 路径，P0-2 迁移用） */
  META_FILENAME: 'meta.json',
  /** 项目 key 的 hash 截断长度 */
  PROJECT_KEY_LENGTH: 16,
  /** 角色/项目记忆索引行预算（与 LIGHT_MEMORY.INDEX_MAX_LINES 同语义） */
  INDEX_MAX_LINES: 200,
  /** write gate 配额：单次实例写回最多条数（设计 §5.1） */
  WRITE_BACK_MAX_ENTRIES: 3,
  /** 写回判断 quick model max_tokens（要容纳最多 3 条记忆正文） */
  WRITE_BACK_MAX_TOKENS: 2048,
  /** 写回判断 quick model 超时（ms），异步执行不阻塞实例返回 */
  WRITE_BACK_TIMEOUT_MS: 20000,
  /** 喂给写回判断的 transcript 截断字符数 */
  WRITE_BACK_TRANSCRIPT_MAX_CHARS: 8000,
  /** 单条写回记忆正文的最大字符数（write gate 质量闸） */
  WRITE_BACK_CONTENT_MAX_CHARS: 4000,
  /** 注入块中履历最多保留的最近条数 */
  INJECT_HISTORY_MAX_ENTRIES: 10,
} as const;

/** GAP-005: 经验沉淀管线（learningPipeline → failure journal / skill 草稿） */
export const LEARNING_PIPELINE = {
  /** 同一失败模式累计出现次数达到该阈值才写入 failure journal */
  FAILURE_PATTERN_THRESHOLD: 3,
  /** 同一成功工具序列出现次数达到该阈值才生成 skill 草稿 */
  SUCCESS_PATTERN_THRESHOLD: 3,
  /** 成功模式提取的工具序列长度范围（n-gram） */
  SUCCESS_SEQUENCE_MIN_LENGTH: 2,
  SUCCESS_SEQUENCE_MAX_LENGTH: 4,
  /** failure journal 最多保留的模式条数（超出按 lastSeen 淘汰最旧的） */
  JOURNAL_MAX_ENTRIES: 30,
  /** 每个模式最多保留的来源 session 数 */
  JOURNAL_MAX_SESSIONS_PER_ENTRY: 5,
  /** 归一化错误消息的截断长度 */
  ERROR_PATTERN_MAX_CHARS: 100,
  /** 注入 system prompt 的 journal 块最多包含的模式条数（按 lastSeen 取最新） */
  INJECTION_MAX_ENTRIES: 15,
  /** failure journal 在 Light Memory 中的文件名 */
  JOURNAL_FILENAME: 'failure-journal.md',
  /** skill 草稿队列目录名（位于 ~/.code-agent/ 下，与 skills/ 平级，避免被 discovery 扫描） */
  DRAFTS_DIR_NAME: 'skill-drafts',
} as const;
