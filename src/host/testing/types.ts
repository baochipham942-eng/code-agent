// ============================================================================
// Agent Auto-Testing Framework - Type Definitions
// ============================================================================

import type {
  EvalRunStamp,
  EvalFailureClassification,
  AiReviewDimension, AiReviewVerdict,
  TelemetryCompleteness,
  ScoreAuthority,
  EvalCompareArm,
} from '../../shared/contract/evaluation';
import type { RunShape } from '../../shared/contract/evaluationBaseline';
import type { AgentPointerEvent } from '../../shared/contract/desktop';
import type { GoalGateVerdict } from '../../shared/contract/agent';
import type { JudgeCalibrationRecord } from './calibration/calibrationRegistry';
import type { ShipGateVerdict } from './comparator/shipGate';

export type { ScoreAuthority } from '../../shared/contract/evaluation';

/**
 * Test case types
 */
export type TestCaseType =
  | 'tool'           // Test individual tool execution
  | 'task'           // Test complete task completion
  | 'conversation'   // Test conversation understanding
  | 'error_handling' // Test error recovery
  | 'multi_step';    // Test multi-step workflows

/**
 * infra_excluded（WP1-2）：429/5xx/网络等基础设施故障，非 agent 能力信号，
 * 不进能力通过率分母、不进 baseline 对账，报告单列。
 */
export type TestStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'partial'
  | 'infra_excluded'
  | 'cost_exceeded'
  | 'not_run';

/**
 * Expected tool call
 */
export interface ExpectedToolCall {
  /** Tool name (supports regex) */
  tool?: string;
  /** Expected success */
  success?: boolean;
  /** Output should contain these strings */
  output_contains?: string[];
  /** Output should NOT contain these strings */
  output_not_contains?: string[];
  /** Arguments should match (partial) */
  args_match?: Record<string, unknown>;
}

/**
 * Expected file operations
 */
export interface ExpectedFiles {
  /** Files that should be created */
  files_created?: string[];
  /** Files that should be modified */
  files_modified?: string[];
  /** File content assertions */
  file_contains?: Record<string, string | string[]>;
  /** Files that should NOT exist */
  files_not_exist?: string[];
  /** Files that should exist (path check only) */
  file_exists?: string[];
  /** File content should NOT contain these strings */
  file_not_contains?: Record<string, string | string[]>;
}

/**
 * Expected error handling
 */
export interface ExpectedErrorHandling {
  /** Agent should handle error gracefully */
  error_handled?: boolean;
  /** Agent should not crash */
  no_crash?: boolean;
  /** Should contain error message */
  error_message_contains?: string[];
  /** Should retry */
  should_retry?: boolean;
}

/**
 * Expected conversation behavior
 */
export interface ExpectedConversation {
  /** Response should contain */
  response_contains?: string[];
  /** Response should NOT contain */
  response_not_contains?: string[];
  /** Should ask clarifying question */
  asks_clarification?: boolean;
  /** Should use todo list */
  uses_todo?: boolean;
}

/**
 * Test case expectations
 */
export interface TestExpectations extends
  ExpectedToolCall,
  ExpectedFiles,
  ExpectedErrorHandling,
  ExpectedConversation {
  /** Maximum number of turns allowed */
  max_turns?: number;
  /** Minimum number of tool calls */
  min_tool_calls?: number;
  /** Maximum number of tool calls */
  max_tool_calls?: number;
  /** Run command and check exit code 0 */
  test_pass?: string;
  /** Any of these tools being called counts as pass (supports regex) */
  tools_any_of?: string[];
  /** GAIA 式判分：提取 "FINAL ANSWER: X" 与真值做 quasi-exact match */
  final_answer?: string;
}

// === 批 6 · B6a：规则式 user simulator（follow_up_prompts 的条件应答升级形态） ===

/**
 * 条件应答规则：对 agent 上一轮输出/工具调用求值，命中则以脚本文本作为下一轮
 * user 输入（确定性，非 LLM）。三分支应答（批准/拒绝/改需求）即三种规则脚本。
 */
export interface UserSimulationRule {
  /** 规则 id（simTurns 记录与 sim_stop_respected 断言的锚点），套件内唯一 */
  id: string;
  /** 匹配条件：给出的条件须全部成立（AND）；至少给一个，禁止空 when 静默全匹配 */
  when: {
    /** 上一轮 assistant 响应文本匹配（大小写不敏感 regex） */
    response_matches?: string;
    /** 上一轮调用过匹配该 regex 的工具 */
    tool_called?: string;
    /** 上一轮调用了 AskUserQuestion（澄清/确认卡在 eval 里的等价交互面） */
    question_asked?: boolean;
  };
  /** 命中后作为下一轮 user 输入发送的文本（respond/stop 至少给一个） */
  respond?: string;
  /** 命中后终止模拟对话：带 respond 则发完拒绝文本再停，不带则直接不应答 */
  stop?: boolean;
  /** 该规则最多命中次数，默认 1（防 agent 复读导致的无限循环） */
  max_matches?: number;
}

export interface UserSimulation {
  /** 条件应答规则，按声明顺序求值，第一条命中的生效 */
  rules: UserSimulationRule[];
  /** 模拟应答总轮数上限（不含初始 prompt），默认 4 */
  max_turns?: number;
  /**
   * 审批门（工具权限）决策注入：eval adapter 的 requestPermission 由写死
   * auto-approve 改为按此策略应答。缺省 = 沿用 auto-approve。
   */
  permission_policy?: 'approve' | 'reject';
  /** reject 策略的作用域：仅拒绝匹配这些 regex 的工具，其余照常放行 */
  permission_reject_tools?: string[];
  /**
   * K5：reject 策略的命令作用域：拒绝 details.command 匹配这些 regex 的请求（与
   * permission_reject_tools 任一命中即拒）。显式 scripted 策略在场时本策略只做收窄
   * （scripted 放行 + 这里拒 ⇒ 拒），让「先确认」题能写「用户对这条命令说不」。
   */
  permission_reject_commands?: string[];
}

// === 批 6 · B6b-①：goal 契约接入 eval（goal 三闸行为回归） ===

/**
 * eval case 侧的 goal 契约声明（YAML snake_case，loader 鸭子类型直通）。
 * 与产品侧 GoalContract 的映射见 goalContractEval.buildLoopGoalContract：
 * eval 无人值守，allowSwarm 默认 false 且不在 case 里暴露——它是实验臂维度
 * （EvalCompareArm.orchestration.allowSwarm），由 adapter 逐 run 传入。
 */
export interface EvalGoalContract {
  /** 自然语言目标；缺省 = 用 case 的 prompt 作为目标文本 */
  goal?: string;
  /** 闸1：退出码 0 即硬达成的 shell 命令（与 review_condition 至少给一个） */
  verify_command?: string;
  /** 闸2：交给 Reviewer 子代理评的软条件 */
  review_condition?: string;
  /** 闸3：token 预算上限（缺省用产品默认） */
  token_budget?: number;
  /** 闸3：轮次上限（缺省用产品默认） */
  max_turns?: number;
  /** 闸3：墙钟时间预算上限（ms，缺省不限时） */
  wall_clock_budget_ms?: number;
}

/** goal_gate 事件的行为落账（只记闸号/极性/verdict 枚举，不记文案） */
interface GoalGateEventRecord {
  gate: number;
  pass: boolean;
  verdict?: GoalGateVerdict;
}

/**
 * goal run 的行为落账（goal_gate / goal_complete 事件 → 断言锚点数据）。
 * status 缺失 = run 结束时终态事件没发——goal_status 断言据此 fail-loud。
 */
export interface GoalRunRecord {
  status?: 'met' | 'aborted';
  degraded?: boolean;
  degradedReason?: string;
  abortReason?: string;
  gateEvents: GoalGateEventRecord[];
}

/** 单次模拟应答的落账记录（transcript 证据；快照取自发送应答之前） */
export interface SimTurnRecord {
  ruleId: string;
  action: 'respond' | 'stop';
  message?: string;
  /** 规则命中时已累计的 toolExecutions 数 —— 之后的执行都发生在本应答之后 */
  toolExecutionsBefore: number;
  /** 规则命中时已累计的 responses 数 */
  responsesBefore: number;
}

/**
 * Single test case definition
 */
export interface TestCase {
  /** Unique identifier */
  id: string;
  /** Test type */
  type: TestCaseType;
  /** Human-readable description */
  description: string;
  /** The prompt to send to the agent (single-turn) */
  prompt: string;
  /** Additional prompts for multi-turn conversations (sent sequentially after first prompt) */
  follow_up_prompts?: string[];
  /** Expected results */
  expect: TestExpectations;
  /** Setup commands to run before test */
  setup?: string[];
  /** Cleanup commands to run after test */
  cleanup?: string[];
  /** Timeout in milliseconds */
  timeout?: number;
  /** 单 case 实际模型成本硬上限（USD）；可由 suite default_max_cost_usd 提供默认值 */
  max_cost_usd?: number;
  /** Tags for filtering */
  tags?: string[];
  /** Suite-level tags inherited for case-bank display and safety classification. */
  inheritedTags?: string[];
  /** Skip this test */
  skip?: boolean;
  /** Only run this test */
  only?: boolean;
  /** Dependencies - other test IDs that must pass first */
  depends_on?: string[];
  /** Reference solution to prove task is solvable */
  reference_solution?: string;
  /** Difficulty level for categorization */
  difficulty?: TestDifficulty;
  /** CASELIST/compare report layer, derived from the owning YAML path. */
  layer?: string;
  /** 答案根已解析，但该题在答案文件中缺席。运行侧必须转为 not_run。 */
  answerSide?: 'missing';
  /** 缺失时本应读取的答案文件。 */
  answerSidePath?: string;
  /** 已解析到的私档答案根。 */
  answerSideRoot?: string;
  /** Test category */
  category?: TestCategory;
  /** Expectation-based assertions (P1) */
  expectations?: Expectation[];
  /** Rotation metadata for test lifecycle */
  rotation?: { introduced: string; retire_after?: string; reason?: string; variant?: number };
  /** 回流草稿溯源：生成该用例的原始会话 id（trajectory:to-case，批 1 B1） */
  sourceSessionId?: string;
  /** 回流草稿 review 状态：pending=未补断言不进正式套件，reviewed=已人工硬化 */
  reviewStatus?: 'pending' | 'reviewed';
  /**
   * 批 6 · B6a：规则式 user simulator（条件应答多轮）。
   * 与 follow_up_prompts 互斥 —— 同时给出视为配置错误，fail-loud。
   */
  user_simulation?: UserSimulation;
  /**
   * 批 6 · B6b-①：goal 契约（case 以 /goal 自治模式跑，三闸行为可回归）。
   * goal 三闸全自动无用户节点 —— 与 user_simulation / follow_up_prompts 互斥，
   * 同时给出视为配置错误，fail-loud。
   */
  goal_contract?: EvalGoalContract;
  /** 附件注入（GAIA 等外部基准）：跑前从 source 拷进工作目录 dest（相对路径，默认 source 的 basename），跑后清理 */
  files?: CaseFileInjection[];
}

/** 单个附件注入声明 */
interface CaseFileInjection {
  /** 本地源文件绝对路径（支持 ~ 前缀） */
  source: string;
  /** 工作目录内相对目标路径；缺省用 source 的 basename */
  dest?: string;
}

/**
 * Test suite definition (loaded from YAML)
 */
export interface TestSuite {
  /** Suite name */
  name: string;
  /** Suite description */
  description?: string;
  /** Test cases */
  cases: TestCase[];
  /** Default timeout for all cases */
  default_timeout?: number;
  /** Global setup */
  setup?: string[];
  /** Global cleanup */
  cleanup?: string[];
  /** Suite tags */
  tags?: string[];
  /** suite 内 case 的默认实际模型成本硬上限（USD） */
  default_max_cost_usd?: number;
}

/**
 * Tool execution record (from agent)
 */
/** 真跑里审批处理器被调用的一条记录（N-EVAL-APPROVALEVAL · B；adapter 的记录器落账） */
export interface PermissionRequestRecord {
  tool: string;
  type: string;
  command?: string;
  path?: string;
  riskLevel?: string;
  /**
   * K5：产品里这次会不会真弹审批卡。scripted 策略下 forcePermissionHandler 让**每次**工具调用都过
   * 处理器，分类器本会自动放行的那些在 decisionTrace 里带 INJECTED_PERMISSION_HANDLER_TRACE_RULE
   * 步 ⇒ false。approval_* 判定只数 true 的记录：处理器被叫 ≠ 卡弹了。
   */
  wouldAsk: boolean;
  /** scripted 策略的应答；是「产品会弹卡」这件事让判定成立，不是应答 */
  decision: 'scripted-allow' | 'scripted-deny';
}

export interface ToolExecutionRecord {
  /** Tool name */
  tool: string;
  /** Input parameters */
  input: Record<string, unknown>;
  /** Output/result */
  output: string;
  /** Success status */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** K5：被审批层拒掉、没有真的执行（tool_call_end 带 failureCode=permission-denied） */
  permissionDenied?: boolean;
  /** Execution duration in ms */
  duration: number;
  /** Timestamp */
  timestamp: number;
}

export interface RealAgentRunTelemetryGate {
  name: 'real-agent-run';
  passed: boolean;
  failures: string[];
}

/**
 * Single test result
 */
export interface TestResult {
  /** Test case ID */
  testId: string;
  /** Test case description */
  description: string;
  /** Initial prompt sent to the agent */
  prompt?: string;
  /** Follow-up prompts sent after the initial prompt */
  followUpPrompts?: string[];
  /** 批 6：user simulator 的应答落账（每次规则命中一条，含快照边界） */
  simTurns?: SimTurnRecord[];
  /** 批 6 · B6b-①：goal run 行为落账（goal_status / goal_evidence_gate 断言的锚点数据） */
  goalRun?: GoalRunRecord;
  /** Status */
  status: TestStatus;
  /** mock 模式显式排除：case 需要真实 agent，reason 必须进入报告。 */
  mockExcluded?: { reason: string };
  /** 真跑中没有调用真实模型的题；不得计为通过，也不得用于设基准。 */
  invalid?: { reason: 'usage_unavailable' | 'mock_excluded' };
  /** Duration in ms */
  duration: number;
  /** Start time */
  startTime: number;
  /** End time */
  endTime: number;
  /** Tool executions during test */
  toolExecutions: ToolExecutionRecord[];
  /** 审批处理器被调用记录（approval_requested / approval_not_requested 的证据源；adapter 没接记录器时缺席） */
  permissionRequests?: PermissionRequestRecord[];
  /** Agent responses */
  responses: string[];
  /** Failure reason if failed */
  failureReason?: string;
  /** 缺失答案侧的可审计定位；与 not_run 一起进入报告。 */
  answerSide?: {
    status: 'missing';
    filePath: string;
    root: string;
  };
  /** Detailed failure info */
  failureDetails?: {
    expected: unknown;
    actual: unknown;
    assertion: string;
  };
  /** Any errors/exceptions */
  errors: string[];
  /** Number of agent turns */
  turnCount: number;
  /** Assertion score (0.0 - 1.0) */
  score: number;
  /** 本 case 内每个 skill 的真实激活次数；缺省/空对象均表示未触发。 */
  skillActivations?: Record<string, number>;
  /** 本 case 内子代理被真正拉起的次数；缺省/0 均表示未出场。 */
  subagentSpawns?: number;
  /** 本 case 由 BudgetService usage 实际归集的美元成本 */
  costUsd?: number;
  /** provider response usage；缺失或混入本地估算时，usageStatus 固定为 usage_unavailable。 */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  usageStatus?: 'available' | 'usage_unavailable';
  /** 本 case 声明的美元成本硬上限 */
  costLimitUsd?: number;
  /** 评分权威桶：分数由确定性断言 / LLM judge / 无外部验证背书 */
  scoreAuthority?: ScoreAuthority;
  aiReview?: Partial<Record<AiReviewDimension, AiReviewVerdict>>;
  /** Pipeline failure stage (from failure funnel analysis) */
  failureStage?: string;
  /** 两轴失败分类：唯一表现码 + 多个处置标签 + 全部命中表现 */
  failure?: EvalFailureClassification;
  /** Reference solution if provided */
  reference_solution?: string;
  /** Expectation-based assertion results (P1) */
  expectationResults?: ExpectationResult[];
  /** Trajectory analysis data (P3) */
  trajectory?: Trajectory;
  /** Trial results when trialsPerCase > 1 */
  trials?: Array<{
    score: number;
    status: TestStatus;
    duration_ms: number;
    sessionId?: string;
    replayKey?: string;
    telemetryCompleteness?: TelemetryCompleteness;
    telemetryGate?: RealAgentRunTelemetryGate;
    failureStage?: string;
    failureReason?: string;
    errors?: string[];
    usageStatus?: 'available' | 'usage_unavailable';
    mockExcluded?: { reason: string };
    invalid?: { reason: 'usage_unavailable' | 'mock_excluded' };
  }>;
  /** Statistical variance of trial scores (when trialsPerCase > 1) */
  variance?: number;
  /** Standard deviation of trial scores (when trialsPerCase > 1) */
  stdDev?: number;
  /** Whether the case is unstable (stdDev > threshold) */
  unstable?: boolean;
  /** Combination-based result for repeated attempts. */
  trialAggregate?: {
    n: number;
    c: number;
    passAtK: number;
    passCaretK: number;
    rule: 'pass_caret_k';
  };
  /** Session ID from the agent that ran this test */
  sessionId?: string;
  /** Replay key derived from the session trace identity */
  replayKey?: string;
  /** Telemetry/replay completeness gathered from structured replay */
  telemetryCompleteness?: TelemetryCompleteness;
  /** Hard gate used by real-agent-run eval cases */
  telemetryGate?: RealAgentRunTelemetryGate;
  /** agent 已启动，case 被 TestRunner 的超时机制终止。 */
  killedByTimeout?: boolean;
}

/**
 * Test run summary
 */
export interface TestRunSummary {
  /** Run ID */
  runId: string;
  /** Start time */
  startTime: number;
  /** End time */
  endTime: number;
  /** Total duration */
  duration: number;
  /** Total test count */
  total: number;
  /** 本轮在执行前确定的计划题集，顺序与依赖排序后的执行顺序一致。 */
  plannedCaseIds: string[];
  /** 计划题集是否全部执行到终态；中断或存在 not_run 时为 false。 */
  completed: boolean;
  /** Passed count */
  passed: number;
  /** Failed count */
  failed: number;
  /** Skipped count */
  skipped: number;
  /** mock 模式因真实 agent 语义而显式排除的 case 数（是 skipped 的子集） */
  mockExcluded?: number;
  /** Partial pass count */
  partial: number;
  /** 环境故障数（429/5xx/网络），不计入通过率 */
  infraExcluded?: number;
  /** 单 case 成本超限数，fail-loud 但不计入通过率 */
  costExceeded?: number;
  /** 计划内未执行的题数；这些题仍计入通过率。 */
  notRun: number;
  /** 已到 rotation.retire_after、因此未进入本轮计划的题目 id。 */
  retiredSkipped?: string[];
  /** 真跑中没有调用真实模型的题数；这些题不得计为通过。 */
  invalidCases: number;
  /** 题级最终失败结果按唯一表现码计数；unknown 始终保留以衡量码本覆盖率。 */
  failureDistribution?: Record<string, number>;
  /** 本轮失败原因码本来自项目配置，还是项目缺失时使用的内置副本。 */
  failureCodebookSource?: 'project' | 'bundled';
  /** Average score across non-skipped tests (0.0 - 1.0) */
  averageScore: number;
  /** Individual results */
  results: TestResult[];
  /** Environment info */
  environment: {
    model: string;
    provider: string;
    workingDirectory: string;
    /** roadmap 2.4 A/B 归因（audit D-R3）：provider 变体臂，
     *  由 CODE_AGENT_DISABLE_PROVIDER_VARIANT 决定 */
    providerVariantArm?: 'variant-on' | 'variant-off';
  };
  /** Complete pre-run configuration identity used for comparisons and reports. */
  stamp: EvalRunStamp;
  /** Performance stats */
  performance: {
    avgResponseTime: number;
    maxResponseTime: number;
    totalToolCalls: number;
    totalTurns: number;
  };
  /** Eval self-evolution feedback (P4) */
  evalFeedback?: EvalFeedback;
  /** Git commit hash at time of test run */
  gitCommit?: string;
  /** Warning message if DB persistence failed (best-effort save) */
  persistenceWarning?: string;
  /** 若被 circuit breaker 熔断（如余额不足），标记为 true，剩余 case 不再执行 */
  aborted?: boolean;
  /** 熔断原因（error message），用于 UI 明确显示失败而非"像未运行" */
  abortReason?: string;
  /** Number of cases with stdDev > threshold (stability metric) */
  unstableCaseCount?: number;
  /** Mean stdDev across all cases with trials (stability metric) */
  averageStdDev?: number;
  /** 本轮主指标的计分规则。 */
  aggregationRule?: 'pass_rate_k1' | 'pass_caret_k';
  /** 计分规则版本；改规则必须 bump。 */
  aggregationRuleVersion?: number;
  /** GAP-017: 本次 run 使用的 harness 配置（对照实验维度，落 DB config_json） */
  harness?: HarnessVariantConfig;
  /** 数据集/套件名（可选）：run 覆盖的 case 全部来自同一 suite 时落该 suite 名，
   *  用于实验命名 eval-<dataset>-<日期>（评测中心基准 tab 按数据集分组） */
  dataset?: string;
  /** WP1-4: 本次 run 登记的 prompt 改动预测（deltaReporter 对账用） */
  prediction?: EvalPrediction;
  /** judge 校准接线：本次 run llm_judge 分数绑定的校准记录；缺失即视为未校准 */
  judgeCalibration?: JudgeCalibrationRecord;
}

// ============================================================================
// GAP-017: Harness 对照实验（固定模型，变 harness 配置）
// ============================================================================

/**
 * Harness 配置维度 — 课程 H2："同一模型在不同 Harness 中的差距 > 不同模型在
 * 同一 Harness 中的差距"。固定模型跑多个 harness 变体做 ablation 对比。
 */
export interface HarnessVariantConfig {
  /** 变体名（用于实验命名和 DB 对比，如 "compression-off" / "hooks-on"） */
  name: string;
  /** context 自动压缩开/关（undefined = 跟随全局配置） */
  contextCompression?: boolean;
  /** messageBuild 六层压缩管线的 L0 + L2-L4 开/关；L1 保持常开，与 contextCompression(autoCompressor) 不同 */
  compressionPipeline?: boolean;
  /** 模型 scaffold profile 开/关（undefined = 跟随生产 flag） */
  scaffoldProfile?: boolean;
  /** 单维度：只覆盖 thinking 注入（B7 定位实验），nudge/修复指令不动 */
  thinkingInjection?: boolean;
  /** hooks 开/关（undefined = 评测默认关闭） */
  hooksEnabled?: boolean;
  /** 工具集维度：'all' 全量加载 | 'deferred' 延迟加载（裁剪模型可见工具面） */
  toolMode?: 'all' | 'deferred';
}

/**
 * WP1-4：prompt 改动的预测登记 — 跑 eval 前声明预计修好/预计有风险的
 * case id 列表，deltaReporter 对账预测命中/落空/预测外翻转。
 */
export interface EvalPrediction {
  /** 预计由本次改动修好的 case id */
  predictedFixes: string[];
  /** 预计可能被本次改动打坏的 case id */
  riskTasks: string[];
}

/**
 * Test runner configuration
 */
export interface TestRunnerConfig {
  /** Optional pre-assigned runId — caller (如评测中心 IPC handler) 传入后
   *  TestRunner 不再自生 uuid，保证 DB 主键和 handler experimentId 一致，
   *  避免 handler 初始 insert + TestRunner 内部 persist 双写成两条记录。 */
  runId?: string;
  /** Child bridge runs emit events only; the app process is the sole experiment DB writer. */
  persistExperiment?: boolean;
  /** Built once by the eval entry point and passed through unchanged. */
  stamp?: EvalRunStamp;
  /** Directory containing test cases */
  testCaseDir: string;
  /** Directory for test results */
  resultsDir: string;
  /** Working directory for tests */
  workingDirectory: string;
  /** Default timeout */
  defaultTimeout: number;
  /**
   * 跑级单 case 成本上限（USD），压过 suite default_max_cost_usd 与 case max_cost_usd。
   * 用途：custom 渠道按设计只给保守 default 价（$1/$3），题面里 0.10 的上限会把 140K+ token 的重题
   * 中途掐成 cost_exceeded；这是跑法配置与计价打架，不是能力信号，跑的人显式给上限自己负责。
   */
  caseCostLimitUsd?: number;
  /** Stop on first failure */
  stopOnFailure: boolean;
  /** Filter by tags */
  filterTags?: string[];
  /** Filter by test IDs */
  filterIds?: string[];
  /** Include cases whose rotation.retire_after is today or earlier. */
  includeRetired?: boolean;
  /** Cases removed by an entry-point preselection before the runner starts. */
  retiredSkipped?: string[];
  /** Verbose logging */
  verbose: boolean;
  /** Parallel execution (future) */
  parallel: boolean;
  /** Max parallel tests */
  maxParallel: number;
  /** Enable trajectory analysis (P3) */
  enableTrajectoryAnalysis?: boolean;
  /** Enable eval self-critic (P4) */
  enableEvalCritic?: boolean;
  /** Use LLM for eval critic analysis (P4) */
  evalCriticUseLLM?: boolean;
  /** 工具加载模式：'all' 全量 | 'deferred' 延迟加载（默认） */
  toolMode?: 'all' | 'deferred';
  /** Number of trials per test case (default 1). When >1, each case runs multiple times for stability measurement */
  trialsPerCase?: number;
  /** GAP-017: harness 配置变体（对照实验维度，随 summary 落 DB） */
  harness?: HarnessVariantConfig;
  /** WP1-4: prompt 改动预测登记（随 summary 落盘/DB，deltaReporter 对账） */
  prediction?: EvalPrediction;
  /** 覆盖默认的 .claude/eval-failcodes.yaml 所在目录，主要供隔离验证使用。 */
  failureCodebookDir?: string;
  aiReview?: AiReviewDimension[];
}

/**
 * Test event for real-time updates
 */
export type TestEvent =
  | { type: 'suite_start'; suite: string; totalCases: number; plannedCaseIds: string[] }
  | { type: 'case_start'; testId: string; description: string }
  | { type: 'case_end'; result: TestResult }
  | { type: 'suite_end'; summary: TestRunSummary }
  | { type: 'tool_call'; testId: string; tool: string; input: unknown }
  | { type: 'tool_result'; testId: string; tool: string; success: boolean }
  | { type: 'skill_activated'; testId: string; name: string }
  | { type: 'memory_injected'; testId: string; id: string }
  | { type: 'subagent_spawned'; testId: string; id: string }
  | { type: 'error'; testId?: string; error: string };

/**
 * Test event listener
 */
export type TestEventListener = (event: TestEvent) => void;


// ============================================================================
// Extended Evaluation System Types (Phase 1)
// ============================================================================

// === P0: Statistical Evaluation Types ===

export interface StatisticalConfig {
  runs: number;                    // default: 3
  concurrency: number;            // default: 1
  flakyThreshold: number;         // default: 0.3
}

export interface StatisticalCaseResult {
  testId: string;
  description: string;
  totalRuns: number;
  runs: TestResult[];
  scoreStats: {
    mean: number;
    stddev: number;
    min: number;
    max: number;
    median: number;
  };
  statusDistribution: {
    passed: number;
    failed: number;
    partial: number;
    skipped: number;
  };
  passAt1: number;      // single-try reliability
  passAtK: number;      // at least 1 pass in k runs
  passCaretK: number;   // all k runs pass (stability)
  isFlaky: boolean;
  avgDuration: number;
  durationStddev: number;
}

export interface StatisticalRunSummary {
  runId: string;
  config: StatisticalConfig;
  startTime: number;
  endTime: number;
  duration: number;
  caseResults: StatisticalCaseResult[];
  aggregate: {
    totalCases: number;
    totalRuns: number;
    overallPassAt1: number;
    overallPassAtK: number;
    overallPassCaretK: number;
    meanScore: number;
    scoreStddev: number;
    flakyCases: string[];
    stableCases: string[];
  };
}

// === P1: Expectation-Based Assertion Types ===

export type TestDifficulty = 'easy' | 'medium' | 'hard';

export type TestCategory = 'basic_tool' | 'task_completion' | 'error_recovery' | 'edge_case';

export type ExpectationType =
  | 'file_exists' | 'file_not_exists'
  | 'content_contains' | 'content_not_contains'
  | 'code_compiles' | 'test_passes'
  | 'output_matches' | 'command_succeeds'
  | 'response_contains' | 'response_not_contains'
  | 'tool_called' | 'tool_output_contains' | 'no_crash' | 'error_handled'
  | 'max_turns' | 'min_tool_calls' | 'max_tool_calls'
  | 'custom_script'
  // artifact_runnable 断言家族（批 3 · B3① 产物终态判据）：产物真跑得起来才算数。
  // params: path（相对 workingDirectory）；expected_verdict（默认 'runnable'，
  // 回归标本 pin 'not_runnable'）；timeout_ms；game_smoke 另有 contract: light|full。
  // 全部 deterministic 桶。fail-loud 语义：非法参数、环境缺浏览器（skipped）、
  // 产物文件缺失（file_missing）一律显式 fail——不假绿、不匹配任何极性、不进 infra 桶。
  | 'html_renders' | 'game_smoke' | 'pptx_opens'
  // 批 6 · B6a：拒绝分支停止语义。params: after_rule（user_simulation 规则 id，必填）、
  // forbidden_tools（regex 列表，默认写效应工具表）。断言 = after_rule 命中之后的
  // toolExecutions 零写效应调用（agent 没有绕过用户拒绝继续执行）。deterministic 桶。
  // fail-loud：缺参 / 该 case 没跑模拟 / 规则未命中，一律显式 fail。
  | 'sim_stop_respected'
  // 批 6 · 审计 R1-H3：先问后做语义（sim_stop_respected 的镜像窗口）。
  // params: before_rule（必填）、forbidden_tools（同上）。断言 = before_rule 命中
  // 之前的 toolExecutions 零写效应调用（agent 没有先斩后奏）。同 fail-loud 口径。
  | 'sim_no_write_before_rule'
  // L3 红线单轮题的过程记录负向判据。params: forbidden_tools / forbidden_commands /
  // forbidden_inputs
  // 至少显式给一个非空 regex 列表；前者匹配工具名（省略即不按工具名判），
  // 命令表只匹配 Bash/Shell/Terminal 类工具的 input.command；输入表匹配任意工具的
  // JSON 序列化 input。空过程记录通过，
  // 但 evidence 必须标明零次工具调用。
  // count_denied（可选布尔，默认 true）：false = 被审批卡拦下的尝试（permissionDenied）不算违规——
  // 「先确认」题的正确路径就是触发审批卡再被拒；「拒绝」题保持默认，任何尝试都算。
  // deterministic 桶；非法参数（缺参、空表、非字符串或非法 regex）fail-loud。
  | 'no_forbidden_tool_call'
  // N-EVAL-APPROVALEVAL · B：审批请求判定，读 adapter 记录器落的 permissionRequests。
  // approval_requested —— params 至少给 commands / paths / tools 之一（regex，盯对象不盯工具名），
  //   至少一条记录匹配即过；用于「不可逆但合理，先确认这轮不执行」的题：证明审批卡真弹了。
  // approval_not_requested —— params 可省（省略 = 任何审批请求都算），没有匹配记录即过；
  //   用于良性对照题：证明没有过度保守。
  // 两者只数 wouldAsk=true（产品会真弹卡）的记录；forced handler 记下的自动放行不算（K5）。
  // 两者在没有记录来源（mock / 旧 adapter）时 fail-loud，不静默算过。deterministic 桶。
  | 'approval_requested'
  | 'approval_not_requested'
  // 批 6 · B6b-①：goal 三闸行为断言（需 case 配 goal_contract）。
  // goal_status —— params: expected（'met'|'aborted' 必填）、degraded（可选布尔 pin，
  // 区分「验证全过的 met」与「修复预算耗尽的降级放行」）。
  // goal_evidence_gate —— params: expected_verdict（闸0 末次 verdict：
  // 'allow_finalize'|'repair_prompt'|'exhausted_release' 必填）、min_bounces
  // （可选，闸0 打回次数下限）。两者 deterministic 桶；fail-loud：缺参 / case 没配
  // goal_contract / 终态事件没发 / 证据闸从未求值，一律显式 fail。
  | 'goal_status'
  | 'goal_evidence_gate'
  // 方案 D 二期遗留：产物任务「先产还是先拖延」的开场判据（实现在 openingShapeEval）。
  // cowork 用例的 file_exists/content_contains 只测「最后有没有文件」，测不到「怎么开场」
  // ——而开场正是产物提示词改的东西（天花板效应：18/19 旧提示词下就已 pass）。
  // params: artifact_tools（必填 regex 列表，锚点=首个产物动作）、stall_tools（必填 regex
  // 列表，该用例下算「拖延」的调研/提问/翻目录工具）。断言 = 锚点之前的窗口零 stall 调用。
  // 窗口语义与 sim_no_write_before_rule 同构。deterministic 桶。
  // fail-loud：缺参 / 两表交集 / 全程无产物动作，一律显式 fail（尤其最后一条——
  // 「压根没产出」会让窗口为空而真空通过，是最危险的假绿）。
  // 刻意无默认工具表：同一个 WebSearch/Read 在「介绍我司项目的 PPT」是对的、在
  // 「Q3 营销方案 PPT」是拖延，极性按用例定，全局默认必在一边造假红。
  | 'no_stall_before_artifact';

export interface Expectation {
  type: ExpectationType;
  description: string;
  weight?: number;           // default: 1.0
  critical?: boolean;        // failure = entire case fails
  params: Record<string, unknown>;
}

export interface ExpectationResult {
  expectation: Expectation;
  passed: boolean;
  evidence: {
    actual: unknown;
    expected: unknown;
    details?: string;
  };
  duration: number;
}

// === P2: A/B Comparison Types ===

export type CompareConfiguration = EvalCompareArm;

export interface DualRubricScore {
  content: { correctness: number; completeness: number; accuracy: number; total: number };
  structure: { organization: number; formatting: number; usability: number; total: number };
  combined: number;
}

export interface CaseComparison {
  testId: string;
  description: string;
  layer?: string;
  assignment: { A: 'baseline' | 'candidate'; B: 'baseline' | 'candidate' };
  scoreA: DualRubricScore;
  scoreB: DualRubricScore;
  /** ABGrader output retained only as an explicitly labelled reference column. */
  referenceWinner: 'A' | 'B' | 'tie';
  referenceKind: 'heuristic' | 'llm_judge';
  /** Deterministic assertion pass-rate winner; the sole per-case conclusion signal. */
  assertionWinner: 'baseline' | 'candidate' | 'tie';
  passRateA: number;
  passRateB: number;
  assertionCount: number;
  realWinner: 'baseline' | 'candidate' | 'tie';
  reasoning: string;
  /** 每臂断言判定终态（非劣判定主指标=成功率；rubric 分只作参考） */
  statusA?: TestStatus;
  statusB?: TestStatus;
  failureA?: EvalFailureClassification;
  failureB?: EvalFailureClassification;
  durationA: number;
  durationB: number;
  skillActivationsA: Record<string, number>;
  skillActivationsB: Record<string, number>;
  /** 每臂子代理拉起次数；0 = 该臂本题没扇出（结论不说明扇出的效果）。 */
  subagentSpawnsA: number;
  subagentSpawnsB: number;
  /** WP1-3b：任一侧没跑成（infra_excluded / 零产出带错误）→ 本 pair 不进胜负统计 */
  excludedReason?: string;
}

export interface ComparisonResult {
  runId: string;
  timestamp: number;
  baseline: CompareConfiguration;
  candidate: CompareConfiguration;
  cases: CaseComparison[];
  summary: {
    totalCases: number;
    baselineWins: number;
    candidateWins: number;
    ties: number;
    baselineAvgScore: number;
    candidateAvgScore: number;
    winner: 'baseline' | 'candidate' | 'tie';
    confidence: number;
    verdict: string;
    /** WP1-3b：因一侧没跑成而排除的 pair 数（不在 totalCases 内） */
    excludedPairs?: number;
    /** Candidate 配置了 skill 但本题零触发，未计入胜负的 pair 数。 */
    skillNotActivatedPairs?: number;
    baselineSkillActivations: Record<string, number>;
    candidateSkillActivations: Record<string, number>;
    /** 配对 sign test 双尾 p 值（只算 decisive pair；tie/excluded 不进 n） */
    pValue?: number;
    shipGate?: ShipGateVerdict;
  };
  duration: number;
}

// === P3: Trajectory Analysis Types ===

export interface TrajectoryStep {
  index: number;
  timestamp: number;
  type: 'tool_call' | 'decision' | 'error' | 'recovery' | 'backtrack' | 'verification';
  toolCall?: {
    name: string;
    args: Record<string, unknown>;
    result?: string;
    success: boolean;
    duration: number;
    agentPointerEvent?: AgentPointerEvent | null;
    agentPointerTimeline?: AgentPointerEvent[];
  };
  decision?: { reasoning: string; chosenAction: string };
  error?: { message: string; code?: string; recoverable: boolean };
  recovery?: { fromStepIndex: number; strategy: string; successful: boolean };
  turnNumber?: number;
  cumulativeTokens?: { input: number; output: number };
}

export interface DeviationMarker {
  stepIndex: number;
  type: 'wrong_tool' | 'unnecessary_step' | 'missed_step' | 'wrong_args' | 'hallucination' | 'loop';
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  suggestedFix?: string;
}

export interface RecoveryPattern {
  errorStepIndex: number;
  recoveryStepIndex: number;
  attempts: number;
  strategy: string;
  successful: boolean;
  tokenCost: number;
}

export interface TrajectoryEfficiency {
  totalSteps: number;
  effectiveSteps: number;
  redundantSteps: number;
  backtrackCount: number;
  totalTokens: { input: number; output: number };
  totalDuration: number;
  tokensPerEffectiveStep: number;
  efficiency: number;    // 0-1
}

export interface Trajectory {
  id: string;
  sessionId: string;
  testCaseId?: string;
  startTime: number;
  endTime: number;
  steps: TrajectoryStep[];
  deviations: DeviationMarker[];
  recoveryPatterns: RecoveryPattern[];
  efficiency: TrajectoryEfficiency;
  summary: {
    intent: string;
    outcome: 'success' | 'partial' | 'failure';
    criticalPath: number[];
    firstDeviationIndex?: number;
  };
}

export interface TrajectoryDiff {
  trajectoryA: string;
  trajectoryB: string;
  commonSteps: number;
  divergencePoint?: number;
  efficiencyDelta: { steps: number; tokens: number; duration: number };
}

// === v2.5 Phase 2: Trajectory Failure Attribution ===

export type FailureCategory =
  | 'tool_error'
  | 'bad_decision'
  | 'missing_context'
  | 'loop'
  | 'hallucination'
  | 'env_failure'
  | 'unknown';

export interface FailureRootCause {
  stepIndex: number;
  category: FailureCategory;
  summary: string;
  evidence: number[];     // related step indices
  confidence: number;     // 0-1
}

export interface CausalChainNode {
  stepIndex: number;
  role: 'root' | 'propagation' | 'terminal';
  note: string;
}

export interface FailureAttribution {
  trajectoryId: string;
  outcome: 'success' | 'partial' | 'failure';
  rootCause?: FailureRootCause;
  causalChain: CausalChainNode[];
  relatedRegressionCases: string[];  // matched reg-* case ids
  llmUsed: boolean;
  durationMs: number;
}

// === P4: Eval Self-Evolution Types ===

export interface AssertionQuality {
  assertionKey: string;
  testCaseId: string;
  quality: 'strong' | 'adequate' | 'weak' | 'unverifiable';
  discriminatingPower: number;   // 0-1
  reason: string;
  suggestion?: string;
}

export interface CoverageGap {
  testCaseId: string;
  category: 'missing_negative_test' | 'missing_edge_case' | 'missing_output_check'
           | 'untested_tool' | 'missing_file_assertion' | 'missing_error_path';
  description: string;
  priority: 'high' | 'medium' | 'low';
}

export interface EvalSuggestion {
  type: 'strengthen_assertion' | 'add_assertion' | 'remove_assertion'
      | 'add_test_case' | 'add_negative_test' | 'split_test';
  targetTestId: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
}

export interface EvalFeedback {
  runId: string;
  timestamp: number;
  testSuiteVersion: string;
  overallQualityScore: number;
  assertionQualities: AssertionQuality[];
  coverageGaps: CoverageGap[];
  suggestions: EvalSuggestion[];
  stats: {
    totalAssertions: number;
    strongAssertions: number;
    weakAssertions: number;
    unverifiableAssertions: number;
    coverageGapCount: number;
  };
}

export interface EvalHistoryEntry {
  version: string;
  parentVersion: string | null;
  timestamp: number;
  runId: string;
  testSuiteHash: string;
  metrics: {
    passRate: number;
    averageScore: number;
    totalCases: number;
    qualityScore: number;
  };
  changes?: string[];
}

export interface EvalHistory {
  currentBest: string;
  entries: EvalHistoryEntry[];
}

// === P5: CI / EDD Types ===

/** eval 运行来源：mock adapter（确定性桩，秒级）vs real 模型执行（分钟级） */
export type EvalRunMode = 'mock' | 'real';

export interface EvalBaseline {
  version: number;
  /** 通过率计算版本：4=计划题集一等字段，未跑题保留在通过率内；缺省=旧规则 */
  denominatorVersion?: number;
  /** 晋升轮次的主指标计分规则；缺省或 legacy 名称均视为旧口径。 */
  aggregationRule?: 'pass_rate_k1' | 'pass_caret_k' | 'best_score_pass_at_k';
  aggregationRuleVersion?: number;
  /** 设为基准时完整执行的计划题集。 */
  plannedCaseIds: string[];
  experimentId?: string;
  commit?: string;
  caseBankSha?: string;
  shape?: RunShape;
  divergesFromProduction?: boolean;
  productionDifferences?: string[];
  excludedCaseIds?: Array<{ id: string; reason: string; approvedBy: string }>;
  knownIssues?: Array<{ caseId: string; reason: string; approvedBy: string; expiresOn: string }>;
  history?: Array<{ experimentId: string; updatedAt: number; updatedBy: string }>;
  updatedAt: number;
  updatedBy: string;
  /** 晋升此 baseline 的运行来源。缺省视为历史遗留（来源不明，可能是 mock） */
  mode?: EvalRunMode;
  globalMetrics: {
    passRate: number;
    averageScore: number;
    totalCases: number;
  };
  caseResults: Record<string, {
    status: string;
    score: number;
    lastPassedAt?: number;
    /** 该分数出自哪个模型（"provider/model"，取 run 级 environment——分数没有模型归因就没法跨基线对比） */
    model?: string;
  }>;
  /** mock-harness baseline 的显式排除名单；real baseline 不写。 */
  excludedCases?: Record<string, string>;
  thresholds: {
    minPassRate: number;
    maxScoreDrop: number;
    maxNewFailures: number;
  };
}

export interface ComparableBaselineDelta {
  comparable: true;
  isFirstRun: boolean;
  passRateDelta: number;
  scoreDelta: number;
  newFailures: Array<{ testId: string; previousStatus: string; currentStatus: string; reason?: string }>;
  newPasses: Array<{ testId: string }>;
  isRegression: boolean;
  regressionDetails: string[];
}

interface IncomparableBaselineDelta {
  comparable: false;
  reason: string;
}

/** 调用方必须先判断 comparable，未跑满或规则过旧时不存在变化值。 */
export type BaselineDelta = ComparableBaselineDelta | IncomparableBaselineDelta;

export interface TrendDataPoint {
  timestamp: number;
  commitSha: string;
  scope: 'smoke' | 'full';
  passRate: number;
  averageScore: number;
  totalCases: number;
  duration: number;
  newFailures: number;
  newPasses: number;
  /** 运行来源。缺省视为历史遗留条目（mock/real 不明），在 real-only 视图中被排除 */
  mode?: EvalRunMode;
  /** WP1-2：本 run 被基础设施故障排除的 case 数（passRate 分母已排除它们） */
  infraExcluded?: number;
  /** 本 run 单 case 成本超限数（passRate 分母已排除） */
  costExceeded?: number;
  /** roadmap 2.4 A/B 归因（audit D-R3）：同 commit 两臂在 trend 里靠它区分 */
  providerVariantArm?: 'variant-on' | 'variant-off';
}
