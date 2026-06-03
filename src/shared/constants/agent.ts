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
  /** 闸1 验证命令超时（ms）；测试/构建可能较久，超时即判失败 */
  VERIFY_TIMEOUT_MS: 600_000,
  /** 闸1 验证输出注回模型时的最大字符数（控 token） */
  VERIFY_OUTPUT_MAX_CHARS: 4_000,
  /** 闸2 Reviewer 子代理迭代上限（够它读文件/跑命令再裁决，又不无限循环） */
  REVIEW_MAX_ITERATIONS: 15,
  /** 闸2 评审理由注回模型时的最大字符数（控 token） */
  REVIEW_OUTPUT_MAX_CHARS: 4_000,
} as const;

/** Swarm goal 配置（P4：goal 内 swarm 执行 + 主动性 advance 合流，docs/designs/swarm-goal.md） */
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
  /** critic 意见注回模型时的最大字符数（控 token） */
  OUTPUT_MAX_CHARS: 4_000,
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
