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

/** 规划配置 */
export const PLANNING = {
  /** 最大 TODO 数量 */
  MAX_TODOS: 50,
  /** 最大 Findings 数量 */
  MAX_FINDINGS: 100,
  /** 计划文件最大大小 */
  MAX_PLAN_SIZE: 50000,
} as const;
