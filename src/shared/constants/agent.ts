/**
 * 系统提示词版本号（人读粗粒度标签，用于 telemetry 归因）。
 *
 * 何时 bump：每次对 system prompt 的静态内容（identity / base / constitution /
 * rules / tools 描述等模块）做有意义的修改时，手动 +1 minor/patch。
 * 用途：让 telemetry trace 标注"这是第几版提示词"，从而能按 promptVersion × errorType
 * 聚合失败率。精确复现仍依赖 turn 级的 systemPromptHash（运行时拼装后的 SHA-256，
 * 已落 system_prompt_cache 全文）—— promptVersion 只是粗标签，不替代 hash。
 */
export const PROMPT_VERSION = 'sys-v11' as const;

/** Agent 配置 */
export const AGENT = {
  /** 最大迭代次数 */
  MAX_ITERATIONS: 30,
  /** 最大重试次数 */
  MAX_RETRIES: 3,
  /** 默认超时时间 (ms) */
  DEFAULT_TIMEOUT: 60000,
  /** 最大消息长度 */
  MAX_MESSAGE_LENGTH: 100000,
  /** 子任务最大深度 */
  MAX_SUBTASK_DEPTH: 5,
} as const;

/** SpawnGuard 子代理守卫（spawn 并发 + 嵌套深度） */
export const SPAWN_GUARD = {
  /** 整棵 spawn 树共享的最大并发 agent 数 */
  MAX_TREE_AGENTS: 8,
  /** 默认 spawn 嵌套深度。3 = 主→子→孙→曾孙，适合上下文卸载默认路径。 */
  DEFAULT_SPAWN_DEPTH: 3,
  /** spawn 嵌套硬上限。会话级覆盖必须 clamp 到此值，避免 5 层以上失控。 */
  HARD_MAX_SPAWN_DEPTH: 5,
  /** 超额 spawn 在全树槽位池里等待的默认时长。 */
  QUEUE_WAIT_TIMEOUT_MS: 30_000,
} as const;

/** Agent 超时配置 (按角色) */
export const AGENT_TIMEOUT = {
  PLANNER: 60000,
  RESEARCHER: 120000,
  CODER: 180000,
  REVIEWER: 90000,
  WRITER: 120000,
  TESTER: 180000,
  COORDINATOR: 300000,
} as const;

/** Agent 迭代配置 (按角色) */
export const AGENT_ITERATIONS = {
  PLANNER: 15,
  RESEARCHER: 20,
  CODER: 30,
  REVIEWER: 20,
  WRITER: 25,
  TESTER: 25,
  COORDINATOR: 50,
} as const;

/** Agent 复杂度配置 */
export const AGENT_COMPLEXITY = {
  LOW: {
    maxTurns: 5,
    timeout: 30_000,
  },
  MEDIUM: {
    maxTurns: 15,
    timeout: 120_000,
  },
  HIGH: {
    maxTurns: 50,
    timeout: 600_000,
  },
} as const;

/** 预定义 Agent 超时配置 */
export const AGENT_TIMEOUTS = {
  /** 代码审查 */
  CODE_REVIEWER: 300_000,
  /** 文档生成 */
  DOC_GENERATOR: 600_000,
  /** 测试生成 */
  TEST_GENERATOR: 300_000,
  /** 重构助手 */
  REFACTOR_ASSISTANT: 300_000,
  /** 安全审计 */
  SECURITY_AUDITOR: 900_000,
  /** 架构分析 */
  ARCHITECTURE_ANALYZER: 1_800_000,
  /** 动态协调器 - Agent 超时 */
  DYNAMIC_AGENT: 300_000,
  /** 动态协调器 - 总超时 */
  DYNAMIC_TOTAL: 1_800_000,
  /** 并行协调器 - 任务超时 */
  PARALLEL_TASK: 120_000,
} as const;

/** Observation Masking 常量 */
export const OBSERVATION_MASKING = {
  PRESERVE_RECENT_COUNT: 10,
  MIN_TOKEN_THRESHOLD: 100,
  PLACEHOLDER_SUCCESS: '[output cleared - tool was executed successfully]',
  PLACEHOLDER_ERROR: '[output cleared - tool returned error]',
  PLACEHOLDER_FILE_READ: '[File content omitted from history to save context. You have already received this file content earlier in this conversation. Do NOT re-read this file unless you have specific reason to believe it changed externally — rely on your prior understanding to proceed.]',
} as const;

/**
 * L0 Active Tool Result Prune 常量。
 * 压缩管线里跑在 L1 tool-result-budget 之前：超预算结果整体换成确定性占位符
 * （先落盘归档再替换），而不是走 L1 的有损 head+tail 截断——占位符与轮次无关，
 * 同内容每轮生成同字节，避免压缩层反复改写内容打掉 provider prompt cache 前缀。
 */
export const ACTIVE_TOOL_RESULT_PRUNE = {
  ENABLED: true,
  /** 高于 L1 的 2000：2000-4096 tokens 之间仍走 L1 有损截断，超过此值才整体换占位符 */
  MAX_TOKENS_PER_RESULT: 4096,
} as const;

/**
 * B7 scaffold profile 总开关：模型能力档 → 脚手架注入厚度映射。
 * 默认关——eval 非劣证据（--compare 配对 + 10pp 边界）出来前不 default-on。
 * 关闭时 resolveScaffoldProfileForModel 恒返 standard，全量行为与现状逐字一致。
 */
export const SCAFFOLD_PROFILE = {
  ENABLED: false,
} as const;

/**
 * 上下文压缩经济学闸（WP2-3）：省下 tokens − 压缩调用成本×权重 ≥ 阈值才提交。
 * 只闸自动触发源（auto_threshold）；手动压缩与溢出恢复不受限。
 */
export const COMPACTION_ECONOMICS = {
  /** 压缩调用成本折权：调用走轻量 compact model 且节省按后续多轮摊销，故折算而非全价 */
  CALL_COST_WEIGHT: 0.2,
  /** 净节省阈值（tokens）：低于此不值得打掉 provider prompt cache 前缀 */
  MIN_NET_SAVINGS_TOKENS: 500,
  /** 连续 N 次摘要失败（校验不过/调用异常）进入冷却 */
  FAILURE_COOLDOWN_THRESHOLD: 3,
  /** 冷却时长（冷却期内跳过付费 AI 摘要，确定性压缩层不受影响） */
  FAILURE_COOLDOWN_MS: 10 * 60 * 1000,
} as const;

/** 子 Agent 上下文压缩配置 */
export const SUBAGENT_COMPACTION = {
  /** 触发压缩的上下文窗口占用比例 */
  THRESHOLD: 0.80,
  /** 尾部保留的消息对数（assistant+user 为一对） */
  PRESERVE_RECENT_PAIRS: 3,
  /** 截断后 user 消息（工具结果）的最大字符数 */
  TOOL_RESULT_MAX_CHARS: 200,
  /** 截断后 assistant 消息（工具调用描述）的最大字符数 */
  ASSISTANT_MAX_CHARS: 400,
  /** 跳过前 N 轮迭代（消息量少无需压缩） */
  SKIP_FIRST_ITERATIONS: 3,
} as const;

/** Goal 模式配置（/goal 自治循环；闸3 兜底阈值，用户可在 goal 契约里覆盖） */
export const GOAL_MODE = {
  /** 默认轮次上限（用户可用 --max-turns 覆盖） */
  DEFAULT_MAX_TURNS: 100,
  /** 默认 token 预算（用户可用 --budget 覆盖；Codex 失控案例烧掉 9 亿 token，必须有兜底） */
  DEFAULT_TOKEN_BUDGET: 2_000_000,
  /** 连续无文件变更轮次阈值 → 判定无进展、强停标 aborted */
  NO_PROGRESS_THRESHOLD: 5,
  /** 目标检查点重注入间隔（轮），对齐 GoalTracker 默认值 */
  CHECKPOINT_INTERVAL: 3,
  /**
   * 简单 goal（纯软目标、无 verify 命令）的审计重注入间隔（轮）。
   * 比基础间隔长——轻任务不需要每 3 轮就跑一次重型完成前自检，省 token 又不脱敏。
   */
  SIMPLE_CHECKPOINT_INTERVAL: 6,
  /**
   * 闸1/闸2 失败后的有界修复机会（三分支裁决：allow_finalize / repair_prompt /
   * exhausted_release）。到限不再注回失败输出，放行收尾但带降级标记——
   * 长任务绝不无限阻塞在验证修复循环里（此前只有 maxIterations 兜底）。
   */
  GATE_REPAIR_MAX_ATTEMPTS: 2,
  /** 闸1 验证命令超时（ms）；测试/构建可能较久，超时即判失败 */
  VERIFY_TIMEOUT_MS: 600_000,
  /** 闸1 验证输出注回模型时的最大字符数（控 token） */
  VERIFY_OUTPUT_MAX_CHARS: 4_000,
  /** 闸2 Reviewer 子代理迭代上限（够它读文件/跑命令再裁决，又不无限循环） */
  REVIEW_MAX_ITERATIONS: 15,
  /** 闸2 评审理由注回模型时的最大字符数（控 token） */
  REVIEW_OUTPUT_MAX_CHARS: 4_000,
  /**
   * 闸0（公开证据自证核验，maka self-check gate 借鉴）的打回预算。
   * 证据不足最多打回这么多次，用尽后放行进闸1/闸2——闸0 是前置增强不设新死锁面。
   */
  EVIDENCE_GATE_MAX_BOUNCES: 2,
  /**
   * goal 模式下 artifact 修复的硬中止倍数：attempts 达到
   * ARTIFACT_REPAIR_MAX_ATTEMPTS × 该倍数仍未过验收 → 直接 markAborted 终止 goal。
   * 背景：admission stop 只 force 当轮 final response，goal 未达成会重进 repair，
   * attempts 无限涨（dogfood 实测烧到 6/4 仍在盲修）。修复轮有文件变更，闸3 的
   * NO_PROGRESS_THRESHOLD 兜不住这种循环。
   */
  ARTIFACT_REPAIR_GOAL_ABORT_MULTIPLIER: 2,
} as const;

/** Swarm goal 配置（P4：goal 内 swarm 执行 + 主动性 advance 合流，内部文档） */
export const SWARM_GOAL = {
  /** 单次 workflow 扇出预算占 goal 剩余预算的最大比例（留余量给主 agent 收尾 + 闸2 评审） */
  MAX_BUDGET_FRACTION: 0.8,
  /** advance 发起的 goal run 默认 token 预算（无人值守场景，远小于交互式 /goal 的默认值） */
  ADVANCE_GOAL_TOKEN_BUDGET: 200_000,
  /** advance 发起的 goal run 默认轮次上限 */
  ADVANCE_GOAL_MAX_TURNS: 30,
  /** advance 目标提案标记提取正则（角色醒来输出 <goal>…</goal> 时升级为 goal run） */
  GOAL_TAG_PATTERN: /<goal>([\s\S]*?)<\/goal>/i,
  /** advance 验收命令提案标记提取正则（可选，有则作为闸1 verify 命令） */
  VERIFY_TAG_PATTERN: /<verify>([\s\S]*?)<\/verify>/i,
} as const;

/** Stop hook 完成闸配置（GAP-006） */
export const STOP_HOOK = {
  /** 用户 Stop hook block 后允许的最大重试（继续干活）次数，超过即放行停止，防 hook 无限拦截死循环 */
  USER_MAX_RETRIES: 1,
} as const;

/** System prompt 预算配置（GAP-023 动态化） */
export const SYSTEM_PROMPT_BUDGET = {
  /** 预算下限（无模型信息/小窗口模型时的默认值，等于历史固定值 6000） */
  MIN_TOKENS: 6000,
  /** 按模型上下文窗口动态计算的比例（大窗口模型不被固定 6000 卡死能力发现块） */
  WINDOW_RATIO: 0.1,
} as const;

/** 多 Agent 流水线反死循环配置（GAP-004） */
export const WORKFLOW_ANTI_LOOP = {
  /** 单 stage 失败后的默认重试次数（stage 可用 maxRetries 覆盖） */
  DEFAULT_MAX_RETRIES: 2,
  /** 同一 workflow run 内允许的总回退（onFailureRoute）次数，超过即 circuit breaker 跳闸暂停 + 通知用户 */
  MAX_TOTAL_FALLBACKS: 1,
} as const;

/** Generator-Critic 交付前自动验证配置（GAP-013） */
export const DELIVERY_CRITIC = {
  /** 触发 critic 的最小修改文件数（修改 ≥N 个文件的 run 才值得花一次子代理审查） */
  FILE_THRESHOLD: 3,
  /** critic 子代理迭代上限 */
  MAX_ITERATIONS: 15,
  /** 每 run 交付前 critic 最多拦下打回次数，达上限强制放行防无限循环 */
  MAX_BLOCKS: 3,
  /** critic 意见注回模型时的最大字符数（控 token） */
  OUTPUT_MAX_CHARS: 4_000,
} as const;

/** Max Mode（best-of-N）配置 — roadmap 3.3，三段式：propose-only 并发 → judge 选索引 → 赢家 replay */
export const MAX_MODE = {
  /** 并发候选数（每步 N 倍模型调用成本，显式开关默认关） */
  DEFAULT_CANDIDATES: 5,
  /** 候选数硬上限（防错误配置导致海量并发扇出，Codex R1-M3） */
  MAX_CANDIDATES: 10,
  /** judge 渲染单个候选的最大字符数（控 judge 输入 token） */
  CANDIDATE_RENDER_MAX_CHARS: 4_000,
} as const;

/** Checkpoint writer 配置（roadmap 3.4） */
export const CHECKPOINT_WRITER = {
  /** 主循环插入重建边界前的短等待窗口；超时即 fail-closed 落回 summary 压缩，避免前台卡住。 */
  REBUILD_FOREGROUND_WAIT_TIMEOUT_MS: 5_000,
  /** writer 后台等待上限；保留给手工/后台证据路径，主循环不再用它阻塞用户。 */
  REBUILD_WAIT_TIMEOUT_MS: 90_000,
  /** writer 子代理单次输出 token 上限（完整 11 段 checkpoint + memory） */
  LLM_MAX_OUTPUT_TOKENS: 8_192,
  /** 验证失败时的最大尝试次数（首次 + 带违规反馈重试） */
  LLM_MAX_ATTEMPTS: 2,
  /** writer 子代理温度（结构化输出要求稳定） */
  LLM_TEMPERATURE: 0.2,
  /** 注入 writer prompt 的会话内容 token 预算 */
  PROMPT_CONVERSATION_MAX_TOKENS: 24_000,
} as const;

/** 规划配置 */
export const PLANNING = {
  /** 最大 TODO 数量 */
  MAX_TODOS: 50,
  /** 最大 Findings 数量 */
  MAX_FINDINGS: 100,
  /** 计划文件最大大小 */
  MAX_PLAN_SIZE: 50000,
} as const;
