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

/**
 * SKILL_REVIEW — 运行时 skill 自沉淀的 LLM 语义复盘链（借鉴 Hermes background_review）。
 * 与 telemetry n-gram 蒸馏并联：n-gram 只看工具序列，这条链让 quick model 读对话内容，
 * 提炼"这一类任务怎么做"的 class-level skill 草稿（仍进 skill-drafts 队列，由用户确认入库）。
 */
export const SKILL_REVIEW = {
  /** quick model max_tokens：需返回含 skill 正文的 JSON，给足余量 */
  MAX_TOKENS: 1024,
  /** LLM 复盘调用超时（ms）。收尾异步执行，不阻塞会话；Mimo 等 reasoning 模型关闭思考后仍可能需要 20s+ 输出 skill 正文 */
  TIMEOUT_MS: 45000,
  /** 参与复盘的最近用户轮数 */
  RECENT_USER_TURNS: 10,
  /** 助手最后回复纳入复盘时的截断字符数 */
  ASSISTANT_SNIPPET_CHARS: 600,
  /** skill 正文最大字符数（防止 LLM 灌水） */
  MAX_BODY_CHARS: 4000,
  /** 建议 skill 名最大长度 */
  MAX_NAME_CHARS: 48,
  /** skill 描述最大字符数 */
  MAX_DESCRIPTION_CHARS: 200,
  /** 触发复盘的最少用户轮数（太短的会话没有可沉淀的"类"） */
  MIN_USER_TURNS: 2,
  /** 自沉淀来源标记（写入草稿 meta.origin / SKILL.md frontmatter，可在设置页筛人建 vs 自沉淀） */
  ORIGIN: 'llm-review',
  /**
   * 命名禁用清单（精确匹配即判低价值）。照搬 Anthropic Agent Skills 的 avoid 列表：
   * 取不出有意义任务名、只能落到这些泛词 → 说明根本不该成为 skill。
   */
  NAME_BLOCKLIST: [
    'helper', 'helpers', 'util', 'utils', 'utility', 'utilities',
    'tool', 'tools', 'toolkit', 'data', 'file', 'files', 'document', 'documents',
    'stuff', 'misc', 'general', 'common', 'demo', 'temp', 'example', 'examples',
    'workflow', 'distilled-workflow', 'skill', 'task', 'tasks',
  ],
  /**
   * 工具/机械动作 token。若一个名字的每一段都落在这里（如 bash-bash-bash、grep-read-edit、
   * run-bash），说明它是"拿工具名拼的"而非从任务意图命名 → 判低价值。
   * 只要有一段是领域词（pdf/tauri/database…）就放行。
   */
  NAME_TOOL_TOKENS: [
    'bash', 'sh', 'shell', 'zsh', 'cmd', 'command', 'commands',
    'read', 'write', 'edit', 'multiedit', 'grep', 'glob', 'ls', 'cat', 'find',
    'run', 'exec', 'execute', 'do', 'step', 'steps', 'action', 'actions',
  ],
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
  /** 角色草稿队列目录名（位于 ~/.code-agent/ 下，与 roles/ 平级，避免被 agentRegistry 扫描）。
   *  对话式建角色：模型起草 → 落草稿 → 用户确认才写 agents/<id>.md（镜像 skill-drafts 范式）。 */
  DRAFTS_DIR_NAME: 'role-drafts',
} as const;

/** 角色主动性（cadence 触发器 + 醒来循环，docs/designs/role-proactivity.md） */
export const ROLE_PROACTIVITY = {
  /** 单次醒来最大工具调用轮数（硬约束，传给醒来实例的 maxIterations） */
  WAKE_MAX_ITERATIONS: 15,
  /** 每角色每天最多醒来次数（cadence + event 合计），超出后本次醒来被 skip */
  MAX_WAKES_PER_DAY: 4,
  /** 长任务门槛：主会话 run 达到这个迭代数才触发 event 醒来（设计 §2.2） */
  LONG_TASK_MIN_TURNS: 5,
  /** 默认每日简报档的 cron 表达式（6 字段，croner）：每天 09:00 本地时间 */
  DAILY_BRIEF_CRON: '0 0 9 * * *',
  /** cadence cron job 的幂等 tag（启动时按 tag 同步注册，参考 memory-consolidation 模式） */
  CADENCE_JOB_TAG: 'role-cadence',
  /** 醒来会话标题前缀（会话列表识别用） */
  WAKE_SESSION_TITLE_PREFIX: '主动巡检',
  /** 醒来实例的运行超时（ms），超时按失败处理 */
  WAKE_TIMEOUT_MS: 600000,
  /** 默认主动等级（角色 frontmatter / settings 都没配置时）。
   *  出厂 silent = 功能默认关闭（opt-in）：用户通过 settings.roleAssets.proactivity 或角色 frontmatter 显式开启。 */
  DEFAULT_LEVEL: 'silent',
  /** 醒来产出里决策标记的提取正则（四选一：advance/report/suggest/silence） */
  DECISION_TAG_PATTERN: /<decision>\s*(advance|report|suggest|silence)\s*<\/decision>/i,
  /** 提取不到决策标记时的保守兜底决策 */
  FALLBACK_DECISION: 'report',
  /** 醒来履历条目的产出摘要截断字符数 */
  HISTORY_SUMMARY_MAX_CHARS: 200,
} as const;

/** GAP-005: 经验沉淀管线（learningPipeline → failure journal / skill 草稿） */
export const LEARNING_PIPELINE = {
  /**
   * telemetry n-gram 成功蒸馏总开关（默认关）。
   * 该路只看工具调用频次、无语义判定，会把"连跑 3 次 bash"误提议成 `bash-bash-bash-bash`
   * 这类垃圾草稿。已确认废弃，沉淀统一走 conversationReview 的 LLM 反思路（见
   * docs/designs/experience-distillation-and-uninstall-fixes.md Part 1）。
   * 暂以开关止血、保留可回滚；重做落地后整条 n-gram 路物理移除。
   */
  TELEMETRY_SKILL_DISTILLATION_ENABLED: false,
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
